// The RPC contract between the Bun process and the view. Requests flow view -> bun;
// messages flow bun -> view (progress and results pushed as they happen). Both travel through
// the Electron main process, which relays them (see src/electron/sidecar.ts) and itself answers
// the Bun process's HostRequests: native dialogs, the shell and the trash.

import type {
    AnalysisSummary, ApplySummary, ConvertResult, ConvertSettings, ConvertSummary, Decision,
    FileAction, Item, Judgement, Settings, Stack,
} from "./types.ts";

export interface InitInfo {
    settings: Settings;
    mediaBase: string;
    mediaToken: string;
    home: string;
    /** Desktop locale ("de-DE", "en"); see app.ts systemLocale. */
    systemLocale: string;
}

export interface EyeInfo {
    state: "idle" | "starting" | "running" | "done" | "error";
    accelerator: "gpu" | "cpu" | null;
    adapter: string | null;
    done: number;
    total: number;
    /** Mean inference time of this run in ms. */
    meanMs: number;
    /** Raw error text when state is "error". */
    message?: string;
    /** Set after the GPU process died and analysis continued on the CPU. */
    fellBackToCpu?: boolean;
}

export interface FolderState {
    folder: string;
    items: Item[];
    ignored: number;
    decisions: Record<string, Decision>;
    analyses: Record<string, AnalysisSummary>;
    judgements: Record<string, Judgement>;
    stacks: Stack[];
}

export interface FileInfo {
    role: "image" | "original" | "raw" | "sidecar" | "motion";
    name: string;
    size: number;
}

export interface Details {
    rows: [string, string][];
    gps: { lat: number; lon: number } | null;
    files: FileInfo[];
}

export interface ApplyPreview {
    actions: FileAction[];
    trash: number;
    unlink: number;
    move: number;
    bytesFreed: number;
    itemsDeleted: number;
    rawsKept: number;
    rawsDeleted: number;
}

export interface ConvertPreview {
    count: number;
    bytes: number;
    /** Kept items that are not converted, with their extension (e.g. "dng", "webp"). */
    skipped: { id: string; ext: string }[];
    gainMaps: number;
    motion: number;
}

export type CataglyphRPC = {
    bun: {
        requests: {
            init: { params: {}; response: InitInfo };
            pickFolder: { params: {}; response: string | null };
            openFolder: { params: { folder: string }; response: FolderState };
            /** Manual decision changes; every change becomes source "manual". */
            setDecisions: { params: { changes: Record<string, Partial<Pick<Decision, "verdict" | "keepRaw">>> }; response: Record<string, Decision> };
            /** Forget manual overrides and return to the classifier's suggestions. */
            resetDecisions: { params: { ids: string[] }; response: Record<string, Decision> };
            startAnalysis: { params: {}; response: EyeInfo };
            stopAnalysis: { params: {}; response: EyeInfo };
            details: { params: { id: string }; response: Details };
            previewApply: { params: { deleteMode: "trash" | "permanent" }; response: ApplyPreview };
            runApply: { params: { deleteMode: "trash" | "permanent" }; response: ApplySummary };
            previewConvert: { params: {}; response: ConvertPreview };
            runConvert: { params: { settings: ConvertSettings }; response: ConvertSummary };
            cancelConvert: { params: {}; response: boolean };
            saveSettings: { params: { settings: Settings }; response: Settings };
            /** Opens a file in the system default application (videos, the folder itself). */
            openExternal: { params: { id?: string; path?: string }; response: boolean };
            /**
             * Makes an item's video playable in the view (the original, or a cached AV1 proxy
             * encoded now; progress arrives as videoProgress). Then load /video.
             */
            prepareVideo: { params: { id: string }; response: { ok: true } | { ok: false; error: string; disabled?: true } };
            /** Opens an https:// link in the default browser (the Desert Ant Labs credit). */
            openUrl: { params: { url: string }; response: boolean };
        };
        messages: {};
    };
    webview: {
        requests: {};
        messages: {
            eye: EyeInfo;
            /** Analyses as they arrive, batched. */
            analyses: Record<string, AnalysisSummary>;
            /** Recomputed after grouping: judgements, stacks and the auto decisions they imply. */
            judged: { judgements: Record<string, Judgement>; stacks: Stack[]; decisions: Record<string, Decision> };
            /** Items whose basics (capture time, size) arrived after openFolder returned. */
            items: Item[];
            applyProgress: { done: number; total: number };
            convertProgress: { result: ConvertResult; done: number; total: number };
            videoProgress: { id: string; pct: number };
        };
    };
};

type BunRequests = CataglyphRPC["bun"]["requests"];
type ViewMessages = CataglyphRPC["webview"]["messages"];

/** The view's typed request functions, `rpc.openFolder({ folder })`. */
export type RequestFunctions = {
    [K in keyof BunRequests]: (params: BunRequests[K]["params"]) => Promise<BunRequests[K]["response"]>;
};

/** What the Bun process implements: one handler per request. */
export type RequestHandlers = {
    [K in keyof BunRequests]: (params: BunRequests[K]["params"]) => BunRequests[K]["response"] | Promise<BunRequests[K]["response"]>;
};

export type MessageHandlers = { [K in keyof ViewMessages]: (payload: ViewMessages[K]) => void };

/** Services of the Electron main process that the Bun process calls. */
export type HostRequests = {
    pickFolder: { params: { start: string }; response: string | null };
    /** Opens a file or folder in the system default application. */
    openPath: { params: { path: string }; response: boolean };
    /** Opens an https:// URL in the default browser. */
    openUrl: { params: { url: string }; response: boolean };
    /** Moves files to the system trash, one result per path (apply/trash.ts on macOS). */
    trash: { params: { paths: string[] }; response: { path: string; ok: boolean; error?: string }[] };
};

/** A request's outcome as it crosses process boundaries: errors travel as their message. */
export type Outcome<T = unknown> = { result: T } | { error: string };

/**
 * Messages on the IPC channel between the Electron main process and the Bun process (JSON).
 * `request`/`response` are the view's requests, relayed; `host`/`hostResponse` the Bun
 * process's calls into the main process.
 */
export type WireMessage =
    | { type: "request"; id: number; method: string; params: unknown }
    | { type: "response"; id: number; outcome: Outcome }
    | { type: "message"; name: string; payload: unknown }
    | { type: "host"; id: number; method: string; params: unknown }
    | { type: "hostResponse"; id: number; outcome: Outcome }
    | { type: "shutdown" };

/** What the preload script exposes to the view as `window.cataglyph`. */
export interface Bridge {
    request(method: string, params: unknown): Promise<Outcome>;
    onMessage(listener: (name: string, payload: unknown) => void): void;
}
