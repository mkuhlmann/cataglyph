// Messages between the main process (eye-client.ts) and the Eye process (eye-process.ts),
// sent over Bun's IPC channel as structured-clone-able plain objects.

import type { AnalysisSummary } from "../../shared/types.ts";

/** Long edge of the image handed to Eye; see eye-process.ts for why 1536. */
export const ANALYSIS_EDGE = 1536;

export type EyeRequest =
    | { type: "init"; modelDir: string }
    | { type: "analyze"; id: string; path: string }
    | { type: "group"; id: string; analyses: string[]; dates: (number | null)[] }
    | { type: "shutdown" };

export type EyeResponse =
    | { type: "ready"; accelerator: "gpu" | "cpu" }
    | { type: "fatal"; message: string }
    | { type: "result"; id: string; summary: AnalysisSummary; json: string }
    | { type: "groups"; id: string; groups: number[][]; best: number[] }
    | { type: "error"; id: string; message: string };
