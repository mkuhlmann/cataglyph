// Types shared by the Bun main process and the Vue view. Everything here crosses the RPC
// boundary as JSON, so no classes, Maps or typed arrays - plain objects and arrays only.

// ============================================================================
// FILES & ITEMS
// ============================================================================

export interface MediaFile {
    /** Absolute path. */
    path: string;
    /** Basename including extension, as on disk (case preserved). */
    name: string;
    /** Lower-case extension without the dot: "jpg", "arw", "pp3". */
    ext: string;
    size: number;
    mtimeMs: number;
}

/**
 * What an item is shown and judged as:
 * - photo:    a still we can display directly (JPG/HEIC/PNG), possibly with a RAW beside it
 * - raw-only: a RAW with no still next to it (iPhone ProRAW, Samsung Expert RAW); shown via
 *             its embedded preview, never converted, and left in place when kept
 * - archived: a JPEG XL (usually step 5's own output); shown and classified like a photo, but
 *             never converted again
 * - video:    a standalone video; poster frame only, never classified or converted
 */
export type ItemKind = "photo" | "raw-only" | "archived" | "video";

/**
 * One "shot": the file you look at plus everything that belongs to it and has to share its
 * fate (deleted together, moved together). Built by scan/pairing.ts.
 */
export interface Item {
    /** Stable id: the primary file's path relative to the opened folder. */
    id: string;
    kind: ItemKind;
    /** The still that is displayed (the .jxl for archived, the RAW for raw-only, or the video). */
    primary: MediaFile;
    /** RAW partner of a photo (ARW/DNG/...). Always null for raw-only and video items. */
    raw: MediaFile | null;
    /** Sidecars describing the primary (DSC0001.JPG.xmp, IMG_1.xmp when there is no RAW). */
    primarySidecars: MediaFile[];
    /** Sidecars describing the RAW (DSC0001.ARW.pp3, DSC0001.ARW.xmp, DSC0001.xmp next to a RAW). */
    rawSidecars: MediaFile[];
    /**
     * Archived items only: stills of the same shot that the JXL was made from and that are
     * still in the folder (DSC0001.JPG next to DSC0001_lossy_d1.0.jxl, after a run that kept
     * originals in place or failed to remove them). Deleted with the item, kept with it.
     */
    originals: MediaFile[];
    /** Live Photo / Android two-file motion photo video, only once verified (see scan.ts). */
    motion: MediaFile | null;
    /** Google/Samsung motion photo with the MP4 embedded in the still. */
    embeddedMotion: boolean;
    /** Ultra HDR / gain-map still: cjxl keeps only the SDR base image. */
    hasGainMap: boolean;
    /** Capture time in seconds since the epoch (DateTimeOriginal + SubSec + offset), null if unknown. */
    captureTime: number | null;
    /** Upright dimensions of the displayed image, 0 until known. */
    width: number;
    height: number;
    /** Cache key for thumbnails and analyses: changes when the primary file changes. */
    contentKey: string;
}

// ============================================================================
// ANALYSIS (Eye)
// ============================================================================

/** A compact, JSON-safe digest of an Eye Analysis: what the UI and the rules need. */
export interface AnalysisSummary {
    /** "eye@v1.0.0" */
    model: string;
    kind: string | null;
    /** Every non-scene tag plus the strongest scenes, tag -> confidence. */
    confidences: Record<string, number>;
    scores: { aesthetic: number; keeper: number; cover: number } | null;
    faces: { box: Box; confidences: Record<string, number>; quality: number }[];
    /** Sharpness probability and a coarse blur map (row-major, higher is blurrier). */
    sharpness: { score: number; blurMap: { width: number; height: number; values: number[] } } | null;
    /** Accelerator that produced it, for the status line. */
    accelerator: "gpu" | "cpu";
    ms: number;
}

export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

// ============================================================================
// DECISIONS
// ============================================================================

export type Verdict = "keep" | "delete";

export interface Decision {
    verdict: Verdict;
    /** auto: from the rules, recomputed freely. manual: the user's call, never overridden. */
    source: "auto" | "manual";
    /** Keep the RAW (moved to RAW/) instead of deleting it when the item is kept. */
    keepRaw: boolean;
}

/**
 * Why an item is flagged: an Eye tag with its confidence, or `duplicate` with the stack's
 * keeper. Structured rather than a sentence so the view can render it in the UI language.
 */
export interface Reason {
    tag: string;
    confidence?: number;
    /** For `duplicate`: file name of the stack's best photo. */
    of?: string;
}

/** Output of classify/rules.ts for one item. */
export interface Judgement {
    flag: boolean;
    reasons: Reason[];
    /** Tags worth a look but not flagged ("eyes_closed", "bad_lighting"). */
    hints: string[];
}

export interface Stack {
    id: string;
    /** Item ids, best first. */
    members: string[];
    best: string;
}

// ============================================================================
// SETTINGS
// ============================================================================

/** Confidence at or above which a tag flags an item for deletion. */
export interface Thresholds {
    blurry: number;
    unusable: number;
    accidental: number;
    technical_flaw: number;
    test_or_duplicate_shot: number;
    /** Hint-only tags (eyes_closed, bad_framing, bad_lighting, forgettable, ...) show from here. */
    hint: number;
    /** Flag the non-best members of a duplicate stack. */
    flagDuplicates: boolean;
}

export interface ConvertSettings {
    mode: "lossy" | "lossless";
    /** Butteraugli distance, as a string so "1.0" keeps its spelling in the file name. */
    distance: string;
    effort: string;
    /** photo_lossy_d1.0.jxl instead of photo_lossy.jxl. */
    paramsInName: boolean;
    /** What happens to the source still after a verified encode. */
    originals: "delete" | "move";
    /** Live/motion photo video: dropped, or written out beside the .jxl. */
    motion: "discard" | "extract";
    /** Also copy XMP/IPTC with exiftool (cjxl embeds Exif on its own). */
    migrateMetadata: boolean;
    concurrency: number;
}

export interface Settings {
    thresholds: Thresholds;
    /** Step 4 default; the dialog checkbox overrides it per run. */
    deleteMode: "trash" | "permanent";
    convert: ConvertSettings;
    /** Try the LiteRT WebGPU (Vulkan) accelerator before falling back to the CPU. */
    useGpu: boolean;
    /** UI language; "auto" follows the system locale (German if it starts with "de"). */
    language: "auto" | "en" | "de";
    /** Detail view: blue/red bar above the photo (and its RAW) showing keep or delete. */
    verdictBar: boolean;
    /**
     * Convert H.264/HEVC videos into a cached 720p AV1 proxy so they play in the detail view
     * (the bundled Chromium can't decode them). Off: only AV1/VP9 clips play in-app.
     */
    transcodeVideos: boolean;
    recentFolders: string[];
}

export const DEFAULT_SETTINGS: Settings = {
    thresholds: {
        blurry: 0.5,
        unusable: 0.5,
        accidental: 0.5,
        technical_flaw: 0.5,
        test_or_duplicate_shot: 0.7,
        hint: 0.5,
        flagDuplicates: true,
    },
    deleteMode: "trash",
    convert: {
        mode: "lossy",
        distance: "1.0",
        effort: "7",
        paramsInName: true,
        originals: "delete",
        motion: "discard",
        migrateMetadata: false,
        concurrency: 8,
    },
    useGpu: true,
    language: "auto",
    verdictBar: true,
    transcodeVideos: true,
    recentFolders: [],
};

// ============================================================================
// FOLDER LAYOUT
// ============================================================================

/** Kept RAWs (and their sidecars) are moved here, inside the opened folder. */
export const RAW_DIR = "RAW";
/** Source stills land here after conversion when ConvertSettings.originals is "move". */
export const ORIGINALS_DIR = "originals";

// ============================================================================
// APPLY (step 4) & CONVERT (step 5)
// ============================================================================

export type FileActionKind = "trash" | "unlink" | "move";

export interface FileAction {
    kind: FileActionKind;
    itemId: string;
    from: string;
    /** Destination for "move". */
    to?: string;
    bytes: number;
    /** Human-readable why, for the summary ("deleted item", "RAW not kept", "keep RAW"). */
    why: string;
}

export interface ActionOutcome {
    action: FileAction;
    ok: boolean;
    error?: string;
}

export interface ApplySummary {
    outcomes: ActionOutcome[];
    trashed: number;
    unlinked: number;
    moved: number;
    failed: number;
    bytesFreed: number;
}

export type ConvertStatus = "ok" | "failed" | "skipped";

export interface ConvertResult {
    itemId: string;
    status: ConvertStatus;
    input: string;
    output?: string;
    inputBytes: number;
    outputBytes: number;
    seconds: number;
    /** Failure reason, or notes ("embedded motion video dropped", "HDR gain map not preserved"). */
    message?: string;
    notes: string[];
}

export interface ConvertSummary {
    results: ConvertResult[];
    ok: number;
    failed: number;
    skipped: number;
    inputBytes: number;
    outputBytes: number;
    /** Toolchain report for the header: cjxl version, exiftool version, self-test outcome. */
    tools: { label: string; version: string; path: string }[];
}
