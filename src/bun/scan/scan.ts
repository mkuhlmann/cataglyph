// Reads one folder (non-recursive), pairs its files into items and verifies which sidecar
// videos really are the motion half of a still.
//
// Motion photos / live photos: a still that has a short video attached to it.
//
//   * Apple Live Photos, and some Android exports, keep the video as a SEPARATE file with
//     the same basename (IMG_4021.HEIC + IMG_4021.MOV). Nothing about the still tells you
//     it exists, so it has to be found by name. Converting the still and leaving that file
//     behind orphans it permanently - its partner is now a .jxl it will never be paired
//     with again.
//
//   * Google/Samsung motion photos EMBED the MP4 in the JPEG itself, appended after the
//     image data and announced through XMP (GCamera:MicroVideo* on older files,
//     Container/GContainer directory entries with a MotionPhoto semantic on newer ones).

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Item, MediaFile } from "../../shared/types.ts";
import { toolPaths } from "../tools.ts";
import { pairFiles } from "./pairing.ts";

// How much of the head of the file to search for the XMP packet. XMP lives in an APP1
// segment near the start; 256KB is far more than it needs and still one cheap read.
const XMP_SCAN_BYTES = 256 * 1024;

// Markers that mean "this still has a video attached". Specific enough not to fire on
// ordinary XMP: MicroVideo is Google's older scheme, MotionPhoto the current one.
const MOTION_XMP_MARKERS = ["MicroVideo", "MotionPhoto"];

// Ultra HDR (hdrgm: XMP namespace) and Apple/Adobe gain maps (GainMap in the metadata).
// cjxl keeps only the SDR base image, so the UI warns when one is present.
const GAIN_MAP_MARKERS = ["hdrgm:", "GainMap"];

// A Live Photo clip is ~1.5-3 s. A name-only match (no identifier on either side) is only
// trusted when the video is this short; a 40 s sunset.mp4 next to sunset.jpg is a video.
const MAX_LIVE_SECONDS = 4;

const HEAD_CONCURRENCY = 16;

// How confident we are that a same-basename video really belongs to this still.
export type SidecarPairing =
    | { kind: "verified"; path: string }   // Apple ContentIdentifier matches on both sides
    | { kind: "name-only"; path: string }  // neither side carries an identifier to check
    | { kind: "rejected"; path: string; reason: string }
    // The check could not be run at all (exiftool failed, a file was unreadable). Distinct
    // from "name-only" on purpose: not knowing is a reason to keep the video, whereas
    // name-only is a positive finding that neither file carries an identifier.
    | { kind: "unknown"; path: string; reason: string };

interface ProbeEntry {
    ContentIdentifier?: string;
    Duration?: number;
}

export interface LivePairingResult {
    pairing: SidecarPairing;
    /** QuickTime duration of the video in seconds, when exiftool reported one. */
    duration: number | null;
}

// Apple writes a shared ContentIdentifier into both halves of a Live Photo - the Apple
// maker note on the still, the QuickTime keys on the video. When both sides have one they
// settle the question outright, which is what keeps an unrelated `sunset.mp4` sitting next
// to `sunset.jpg` from being treated as a live photo and deleted.
//
// Android motion photos exported as two files carry no such identifier. That case can only
// ever be a name match, and is reported as such rather than dressed up as verified.
//
// All candidates go through ONE exiftool process (spawning one per pair costs ~100 ms each
// on a folder of hundreds of Live Photos).
export async function classifyPairs(pairs: { still: string; video: string }[]): Promise<LivePairingResult[]> {
    if (pairs.length === 0) return [];
    const unknown = (reason: string): LivePairingResult[] =>
        pairs.map(p => ({ pairing: { kind: "unknown", path: p.video, reason }, duration: null }));

    const args = pairs.flatMap(p => [p.still, p.video]);
    let stdout: string;
    try {
        const proc = Bun.spawn(
            [toolPaths().exiftool, "-json", "-n", "-ContentIdentifier", "-Duration", ...args],
            { stdout: "pipe", stderr: "ignore" },
        );
        stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) return unknown(`exiftool exited ${exitCode}`);
    } catch (error) {
        return unknown(`could not run exiftool: ${String(error)}`);
    }

    // exiftool returns one object per input, in the order they were given, and echoes
    // SourceFile as it was passed rather than as a normalised path - so position is the
    // reliable key here, not a string comparison against our own paths.
    let entries: ProbeEntry[];
    try {
        entries = JSON.parse(stdout) as ProbeEntry[];
    } catch {
        return unknown("could not parse exiftool's output");
    }
    // Anything other than one object per input means exiftool could not read one of
    // them, so there is nothing to conclude.
    if (entries.length !== args.length) {
        return unknown(`exiftool read ${entries.length} of ${args.length} files`);
    }

    return pairs.map((p, i) => {
        const stillId = entries[i * 2]?.ContentIdentifier;
        const videoEntry = entries[i * 2 + 1];
        const videoId = videoEntry?.ContentIdentifier;
        const duration = typeof videoEntry?.Duration === "number" ? videoEntry.Duration : null;

        if (stillId !== undefined && videoId !== undefined) {
            const pairing: SidecarPairing = String(stillId) === String(videoId)
                ? { kind: "verified", path: p.video }
                : { kind: "rejected", path: p.video, reason: "ContentIdentifier differs, these are not a pair" };
            return { pairing, duration };
        }

        // Exactly one side has an identifier. A genuine Live Photo always has both, so this
        // is some other video that happens to share the name - keep it.
        if (stillId !== undefined || videoId !== undefined) {
            const which = stillId !== undefined ? "the still" : "the video";
            return {
                pairing: {
                    kind: "rejected" as const,
                    path: p.video,
                    reason: `only ${which} has a ContentIdentifier, so they are not a Live Photo pair`,
                },
                duration,
            };
        }

        return { pairing: { kind: "name-only" as const, path: p.video }, duration };
    });
}

// Merge only on positive evidence: a matching identifier, or a name match on a clip short
// enough to be a Live Photo. Not knowing is a reason to keep things separate.
export function shouldMerge(result: LivePairingResult): boolean {
    if (result.pairing.kind === "verified") return true;
    return result.pairing.kind === "name-only"
        && result.duration !== null
        && result.duration <= MAX_LIVE_SECONDS;
}

// Reads the head of the file directly rather than shelling out to exiftool: this runs for
// every still, and the common case (an ordinary photo) has to stay free.
async function scanHead(path: string): Promise<{ embeddedMotion: boolean; hasGainMap: boolean }> {
    try {
        const head = await Bun.file(path).slice(0, XMP_SCAN_BYTES).text();
        return {
            embeddedMotion: MOTION_XMP_MARKERS.some(marker => head.includes(marker)),
            hasGainMap: GAIN_MAP_MARKERS.some(marker => head.includes(marker)),
        };
    } catch {
        return { embeddedMotion: false, hasGainMap: false };
    }
}

async function mapLimit<T>(list: T[], limit: number, fn: (value: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < list.length) {
            const value = list[next++];
            if (value !== undefined) await fn(value);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

export async function scanFolder(folder: string): Promise<{ items: Item[]; ignored: MediaFile[] }> {
    const entries = await readdir(folder, { withFileTypes: true });
    const files: MediaFile[] = [];
    await Promise.all(entries.map(async entry => {
        // Directories (RAW/, originals/ that the app itself creates) are never scanned.
        if (!entry.isFile()) return;
        const path = join(folder, entry.name);
        try {
            const info = await stat(path);
            const dot = entry.name.lastIndexOf(".");
            files.push({
                path,
                name: entry.name,
                ext: dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "",
                size: info.size,
                mtimeMs: info.mtimeMs,
            });
        } catch {
            // Vanished between readdir and stat: nothing to show.
        }
    }));
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const { items, ignored, liveCandidates } = pairFiles(files, folder);
    const byId = new Map(items.map(item => [item.id, item]));

    // Resolve candidates to concrete still paths first, then probe them in one batch.
    const probes: { item: Item; video: MediaFile }[] = [];
    for (const candidate of liveCandidates) {
        const item = byId.get(candidate.itemId);
        if (item) probes.push({ item, video: candidate.video });
    }
    const results = await classifyPairs(probes.map(p => ({ still: p.item.primary.path, video: p.video.path })));
    const merged = new Set<string>();
    probes.forEach((probe, i) => {
        const result = results[i];
        // A still takes at most one motion video.
        if (result && probe.item.motion === null && shouldMerge(result)) {
            probe.item.motion = probe.video;
            merged.add(probe.video.path);
        }
    });

    const stills = items.filter(item => item.kind === "photo");
    await mapLimit(stills, HEAD_CONCURRENCY, async item => {
        const flags = await scanHead(item.primary.path);
        item.embeddedMotion = flags.embeddedMotion;
        item.hasGainMap = flags.hasGainMap;
    });

    return { items: items.filter(item => !(item.kind === "video" && merged.has(item.primary.path))), ignored };
}
