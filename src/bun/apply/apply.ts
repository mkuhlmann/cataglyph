import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionOutcome, ApplySummary, FileAction } from "../../shared/types.ts";
import { moveToTrash } from "./trash.ts";
import type { TrashOptions } from "./trash.ts";

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Run the plan. Order matters: moves first (a RAW we were asked to keep is safe before
 * anything is deleted), then trash, then permanent unlinks. Every action is independent and
 * wrapped on its own: one locked or vanished file must never abort the rest of a 3000-file
 * run, it is just reported as failed.
 */
export async function executeApply(
    actions: FileAction[],
    onProgress?: (done: number, total: number, outcome: ActionOutcome) => void,
    trashOpts: TrashOptions = {},
): Promise<ApplySummary> {
    const outcomes: ActionOutcome[] = [];
    const total = actions.length;

    const record = (action: FileAction, ok: boolean, error?: string): void => {
        const outcome: ActionOutcome = ok ? { action, ok } : { action, ok, error: error ?? "failed" };
        outcomes.push(outcome);
        try {
            onProgress?.(outcomes.length, total, outcome);
        } catch {
            // A broken progress listener must not stop the run.
        }
    };

    // --- moves ---
    const madeDirs = new Set<string>();
    for (const action of actions.filter((a) => a.kind === "move")) {
        try {
            if (!(await exists(action.from))) {
                record(action, false, "missing");
                continue;
            }
            if (!action.to) {
                record(action, false, "move without destination");
                continue;
            }
            // rename() silently replaces an existing file; a same-named RAW from an earlier
            // run must not be clobbered, so check first and fail that file only.
            if (await exists(action.to)) {
                record(action, false, "destination exists");
                continue;
            }
            const dir = dirname(action.to);
            if (!madeDirs.has(dir)) {
                await mkdir(dir, { recursive: true });
                madeDirs.add(dir);
            }
            await rename(action.from, action.to);
            record(action, true);
        } catch (error) {
            record(action, false, message(error));
        }
    }

    // --- trash (batched) ---
    const trashable: FileAction[] = [];
    for (const action of actions.filter((a) => a.kind === "trash")) {
        if (await exists(action.from)) trashable.push(action);
        else record(action, false, "missing");
    }
    if (trashable.length > 0) {
        const batchSize = trashOpts.batchSize ?? 100;
        for (let i = 0; i < trashable.length; i += batchSize) {
            const batch = trashable.slice(i, i + batchSize);
            let results;
            try {
                results = await moveToTrash(batch.map((a) => a.from), trashOpts);
            } catch (error) {
                results = batch.map((a) => ({ path: a.from, ok: false, error: message(error) }));
            }
            batch.forEach((action, index) => {
                const result = results[index];
                if (result?.ok) record(action, true);
                else record(action, false, result?.error ?? "trash failed");
            });
        }
    }

    // --- permanent delete ---
    for (const action of actions.filter((a) => a.kind === "unlink")) {
        try {
            if (!(await exists(action.from))) {
                record(action, false, "missing");
                continue;
            }
            await unlink(action.from);
            record(action, true);
        } catch (error) {
            record(action, false, message(error));
        }
    }

    const summary: ApplySummary = { outcomes, trashed: 0, unlinked: 0, moved: 0, failed: 0, bytesFreed: 0 };
    for (const { action, ok } of outcomes) {
        if (!ok) {
            summary.failed++;
        } else if (action.kind === "move") {
            summary.moved++;
        } else {
            if (action.kind === "trash") summary.trashed++;
            else summary.unlinked++;
            summary.bytesFreed += action.bytes;
        }
    }
    return summary;
}
