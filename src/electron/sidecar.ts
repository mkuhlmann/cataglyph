// The Bun process, seen from the Electron main process: starts it, relays the view's
// requests to it and its messages back, and answers its calls into the main process.
//
// Why a separate Bun process instead of running the app in Electron's Node: the backend is
// built on Bun (Bun.Image decodes every thumbnail and the Eye input, bun:sqlite holds the
// decisions, Bun.serve is the media server, Bun.spawn's IPC talks to the Eye process). Electron
// only contributes the window and what needs the native toolkit: dialogs, the shell, the trash.
//
// The channel is Node's IPC with JSON serialization, which Bun implements as process.send /
// process.on("message") in the child (src/bun/host.ts).

import { spawn, type ChildProcess } from "node:child_process";

import type { Outcome, WireMessage } from "../shared/rpc.ts";

type HostHandler = (params: any) => unknown;

export interface SidecarOptions {
    /** The bun executable and the bundled entry (build/app/bun/index.js). */
    bun: string;
    entry: string;
    env: NodeJS.ProcessEnv;
    /** Services the Bun process may call (HostRequests in shared/rpc.ts). */
    host: Record<string, HostHandler>;
    /** A message for the view. */
    onMessage: (name: string, payload: unknown) => void;
    /** The process ended without being asked to. */
    onExit: (reason: string) => void;
}

export class Sidecar {
    private proc: ChildProcess;
    private pending = new Map<number, (outcome: Outcome) => void>();
    private seq = 0;
    private stopping = false;

    constructor(private opts: SidecarOptions) {
        this.proc = spawn(opts.bun, [opts.entry], {
            env: opts.env,
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            serialization: "json",
        });
        this.proc.on("message", (msg: WireMessage) => this.receive(msg));
        this.proc.on("error", err => this.ended(`could not start ${opts.bun}: ${err.message}`));
        this.proc.on("exit", (code, signal) => this.ended(`exited (${signal ?? code})`));
    }

    private ended(reason: string) {
        for (const resolve of this.pending.values()) resolve({ error: `Bun process ${reason}` });
        this.pending.clear();
        if (!this.stopping) this.opts.onExit(reason);
    }

    private post(msg: WireMessage) {
        if (this.proc.connected) this.proc.send(msg);
    }

    private receive(msg: WireMessage) {
        switch (msg.type) {
            case "response": {
                const resolve = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                resolve?.(msg.outcome);
                return;
            }
            case "message":
                this.opts.onMessage(msg.name, msg.payload);
                return;
            case "host":
                void this.answerHost(msg.id, msg.method, msg.params);
                return;
        }
    }

    private async answerHost(id: number, method: string, params: unknown) {
        let outcome: Outcome;
        try {
            const handler = this.opts.host[method];
            if (!handler) throw new Error(`unknown host request ${method}`);
            outcome = { result: await handler(params) };
        } catch (err) {
            outcome = { error: err instanceof Error ? err.message : String(err) };
        }
        this.post({ type: "hostResponse", id, outcome });
    }

    /** Relays one of the view's requests. Never rejects: failures come back as `{ error }`. */
    request(method: string, params: unknown): Promise<Outcome> {
        if (!this.proc.connected) return Promise.resolve({ error: "Bun process is not running" });
        const id = ++this.seq;
        return new Promise(resolve => {
            this.pending.set(id, resolve);
            this.post({ type: "request", id, method, params });
        });
    }

    /**
     * Asks the process to shut down (it stops Eye and exiftool and closes the databases) and
     * waits for it, killing it if it takes longer than `timeoutMs`.
     */
    async stop(timeoutMs = 5000): Promise<void> {
        this.stopping = true;
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
        const exited = new Promise<void>(resolve => this.proc.once("exit", () => resolve()));
        this.post({ type: "shutdown" });
        const timer = setTimeout(() => this.proc.kill("SIGKILL"), timeoutMs);
        await exited;
        clearTimeout(timer);
    }
}
