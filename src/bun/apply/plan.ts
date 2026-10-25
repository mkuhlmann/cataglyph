import { join } from "node:path";
import { RAW_DIR } from "../../shared/types.ts";
import type { Decision, FileAction, FileActionKind, Item, MediaFile } from "../../shared/types.ts";

export interface PlanOptions {
    /** The opened folder; kept RAWs go to <folder>/RAW. */
    folder: string;
    deleteMode: "trash" | "permanent";
}

/**
 * Turn decisions into a flat, deterministic list of file actions. Pure: nothing is touched
 * here so the confirmation dialog can show exactly what step 4 will do before it does it.
 *
 * Not knowing means keeping: an item without a decision yields no actions, and a kept
 * item only ever loses its RAW side (never the displayed still).
 */
export function planApply(items: Item[], decisions: Record<string, Decision>, opts: PlanOptions): FileAction[] {
    const removeKind: FileActionKind = opts.deleteMode === "permanent" ? "unlink" : "trash";
    const actions: FileAction[] = [];

    const remove = (item: Item, files: MediaFile[], why: string): void => {
        for (const file of files) {
            actions.push({ kind: removeKind, itemId: item.id, from: file.path, bytes: file.size, why });
        }
    };

    for (const item of items) {
        const decision = decisions[item.id];
        if (!decision) continue;

        const rawSide: MediaFile[] = item.raw ? [item.raw, ...item.rawSidecars] : [...item.rawSidecars];

        if (decision.verdict === "delete") {
            // Order: primary, the stills an archived JXL was made from, sidecars, raw side,
            // motion (stable for the summary and tests).
            remove(item, [item.primary, ...item.originals, ...item.primarySidecars, ...rawSide, ...(item.motion ? [item.motion] : [])], "deleted item");
            continue;
        }

        // Keep. Only photos (and archived JXLs) with a RAW partner have anything to decide; an
        // archived item's originals stay where they are, like the still itself. Raw-only and video
        // items have item.raw === null, and a kept raw-only stays exactly where it is.
        if (!item.raw) continue;
        if (decision.keepRaw) {
            for (const file of rawSide) {
                actions.push({
                    kind: "move",
                    itemId: item.id,
                    from: file.path,
                    to: join(opts.folder, RAW_DIR, file.name),
                    bytes: file.size,
                    why: "keep RAW",
                });
            }
        } else {
            remove(item, rawSide, "RAW not kept");
        }
    }
    return actions;
}

export interface PlanSummary {
    trash: number;
    unlink: number;
    move: number;
    /** Bytes that leave the folder for good (or for the trash): trash + unlink. */
    bytesFreed: number;
}

export function summarizePlan(actions: FileAction[]): PlanSummary {
    const summary: PlanSummary = { trash: 0, unlink: 0, move: 0, bytesFreed: 0 };
    for (const action of actions) {
        summary[action.kind]++;
        if (action.kind !== "move") summary.bytesFreed += action.bytes;
    }
    return summary;
}
