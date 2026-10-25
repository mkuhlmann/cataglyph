// Thin wrappers over Bun.spawn for the two shapes the convert module needs: "run it and tell
// me the exit code" and "run it and give me its output".
// Ported from media-batch/lib/proc.ts.

export interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export async function run(cmd: string[], env?: Record<string, string>): Promise<RunResult> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { exitCode: await proc.exited, stdout, stderr };
}

export async function runQuiet(cmd: string[], env?: Record<string, string>): Promise<number> {
    return await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", env }).exited;
}

// Last non-empty line of a tool's stderr - the part that actually names the failure.
export function lastLine(text: string): string {
    const lines = text.trim().split("\n").filter(l => l.trim() !== "");
    return lines[lines.length - 1] ?? "";
}
