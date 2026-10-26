// JPEG XL conversion of kept stills. Port of media-batch/jxl-batch.ts (processFile and the
// batch driver), adapted: the scan module already did pairing/classification, so each job
// arrives with its verified motion video, and the app (not a CLI flag) decides what happens
// to the original.
//
// Invariant (see CLAUDE.md): an original is never touched before its replacement is
// verified - cjxl exited 0, the output exists and is non-empty, and the capture time and
// camera model read back identical from the output.

import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { ORIGINALS_DIR } from "../../shared/types.ts";
import type { ConvertResult, ConvertSettings, ConvertSummary, MediaFile } from "../../shared/types.ts";
import { toolPaths } from "../tools.ts";
import { errorMessage, runConcurrent } from "./batch.ts";
import { migrateMetadata, readBack } from "./exif.ts";
import { decodeHeicToTemp } from "./heic.ts";
import { extractMotionVideo, rehomeSidecar, stripMotionMetadata } from "./motion.ts";
import { runQuiet } from "./proc.ts";
import { checkCjxl, exiftoolVersion, selfTestExifPipeline } from "./selftest.ts";

export interface ConvertJob {
    itemId: string;
    still: MediaFile;
    /** Verified Live Photo / two-file motion photo video. */
    motion: MediaFile | null;
    embeddedMotion: boolean;
    hasGainMap: boolean;
}

// HEIC/HEIF can't be fed to cjxl directly - they're decoded to an intermediate raster first.
const HEIF_EXTENSIONS = new Set(["heic", "heif"]);
const SUPPORTED_EXTENSIONS = new Set(["jpg", "jpeg", "png", ...HEIF_EXTENSIONS]);

const SUFFIX_LOSSY = "_lossy";
const SUFFIX_LOSSLESS = "_lossless";

const fileExists = (path: string) => stat(path).then(() => true, () => false);

// Suffix appended to every output basename: "_lossy_d1.0" / "_lossy" / "_lossless". The
// distance is baked in by default so runs with different settings land in distinct files
// instead of silently overwriting each other. (Lossless has no distance, so no tag.)
function suffixFor(settings: ConvertSettings): string {
    if (settings.mode === "lossless") return SUFFIX_LOSSLESS;
    return settings.paramsInName ? `${SUFFIX_LOSSY}_d${settings.distance}` : SUFFIX_LOSSY;
}

export function outputPathFor(still: MediaFile, settings: ConvertSettings): string {
    const stem = basename(still.path, extname(still.path));
    return join(dirname(still.path), `${stem}${suffixFor(settings)}.jxl`);
}

function emptyResult(job: ConvertJob, status: ConvertResult["status"], message?: string): ConvertResult {
    return {
        itemId: job.itemId, status, input: job.still.path, inputBytes: job.still.size, outputBytes: 0,
        seconds: 0, notes: [], ...(message !== undefined ? { message } : {}),
    };
}

// Moves the original into <dir>/originals/ without ever clobbering. Returns a note when the
// original had to stay in place.
async function moveToOriginals(still: MediaFile, madeDirs: Set<string>): Promise<{ moved: boolean; note?: string }> {
    const dir = join(dirname(still.path), ORIGINALS_DIR);
    if (!madeDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        madeDirs.add(dir);
    }
    const target = join(dir, basename(still.path));
    if (await fileExists(target)) {
        return { moved: false, note: `${ORIGINALS_DIR}/${basename(target)} already exists, original kept in place` };
    }
    await rename(still.path, target);
    return { moved: true };
}

async function convertOne(
    job: ConvertJob,
    settings: ConvertSettings,
    cjxl: string,
    madeDirs: Set<string>,
): Promise<ConvertResult> {
    const { still } = job;
    const ext = still.ext.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return emptyResult(job, "skipped", `unsupported format .${ext}`);
    }
    const outputPath = outputPathFor(still, settings);
    // Never overwrite: an existing output is a previous run's work (or someone else's file).
    if (await fileExists(outputPath)) {
        return emptyResult(job, "skipped", "output exists");
    }

    const started = performance.now();
    const result = emptyResult(job, "failed");
    const fail = async (message: string, discardOutput: boolean): Promise<ConvertResult> => {
        if (discardOutput) await unlink(outputPath).catch(() => {});
        result.status = "failed";
        result.message = message;
        result.seconds = (performance.now() - started) / 1000;
        return result;
    };

    const isHeif = HEIF_EXTENSIONS.has(ext);
    let tempIntermediate: string | null = null;
    try {
        let encodeInput = still.path;
        if (isHeif) {
            try {
                tempIntermediate = await decodeHeicToTemp(still.path);
            } catch (err) {
                return await fail(errorMessage(err), false);
            }
            encodeInput = tempIntermediate;
        }

        const args = [encodeInput, outputPath];
        if (settings.mode === "lossy") {
            args.push("-d", settings.distance, "-e", settings.effort, "--lossless_jpeg=0");
        } else {
            // Lossless JPEG transcode (reversible) for JPEG input, lossless for PNG/PPM.
            args.push("-e", settings.effort);
        }
        const exitCode = await runQuiet([cjxl, ...args]);
        if (exitCode !== 0) return await fail(`encode failed (exit ${exitCode})`, true);

        // Re-attach metadata from the original now that the compressed output exists. Always
        // needed for HEIC (the intermediate raster drops all metadata); opt-in otherwise
        // since cjxl embeds Exif on its own. A failure means the output may lack metadata
        // the original had, so it is a hard failure - the output is discarded.
        if (isHeif || settings.migrateMetadata) {
            const exit = await migrateMetadata(still.path, outputPath);
            if (exit !== 0) {
                return await fail(
                    `metadata migration failed (exit ${exit}), discarded output to avoid losing EXIF`, true,
                );
            }
            if (isHeif) {
                // libheif already applied the container rotation to the pixels; the copied
                // EXIF Orientation would rotate them a second time in viewers.
                await runQuiet([toolPaths().exiftool, "-Orientation#=1", "-overwrite_original", "-m", "-q", "-q", outputPath]);
            }
        }

        // Verify BEFORE touching the original (the invariant of this whole app).
        const outSize = await stat(outputPath).then(s => s.size, () => 0);
        if (outSize <= 0) return await fail("output missing or empty after a successful encode", true);
        const [before, after] = await Promise.all([readBack(still.path), readBack(outputPath)]);
        for (const tag of ["DateTimeOriginal", "Model"] as const) {
            if (before[tag] !== undefined && before[tag] !== after[tag]) {
                return await fail(
                    `metadata did not survive (${tag}: expected ${JSON.stringify(before[tag])}, got ${JSON.stringify(after[tag] ?? null)}), output discarded, original untouched`,
                    true,
                );
            }
        }
        result.output = outputPath;
        result.outputBytes = outSize;
        result.status = "ok";

        // Embedded motion payload: cjxl ignores the MP4 appended behind the image, which is
        // the outcome we want. Extract it first when asked (the strip below removes the XMP
        // that describes it), named after the *output*.
        const notes = result.notes;
        let extracted = false;
        if (job.embeddedMotion && settings.motion === "extract") {
            const videoPath = join(dirname(outputPath), `${basename(outputPath, ".jxl")}.mp4`);
            if (await fileExists(videoPath)) {
                notes.push(`${basename(videoPath)} already exists, embedded motion video not extracted`);
            } else {
                const r = await extractMotionVideo(still.path, videoPath);
                if (r.ok) {
                    extracted = true;
                } else {
                    notes.push(`could not extract the embedded motion video: ${r.reason}`);
                }
            }
        }
        if (job.embeddedMotion) {
            notes.push(extracted ? "embedded motion video extracted" : "embedded motion video dropped");
            // In lossless mode cjxl carries the source XMP across, leaving the output
            // announcing a video at an offset past its own end; clear those tags.
            if (settings.mode === "lossless") {
                const stripExit = await stripMotionMetadata(outputPath);
                if (stripExit !== 0) {
                    notes.push(`could not strip motion-photo XMP (exit ${stripExit}); the output still advertises a video it no longer contains`);
                }
            }
        }
        if (job.hasGainMap) notes.push("HDR gain map not preserved (SDR base only)");

        // The original still, only now that the output is verified. A failure here is a note,
        // not a failed job: the output is good, the source just stays.
        let originalHandled = false;
        try {
            if (settings.originals === "delete") {
                await unlink(still.path);
                originalHandled = true;
            } else {
                const moved = await moveToOriginals(still, madeDirs);
                originalHandled = moved.moved;
                if (moved.note) notes.push(moved.note);
            }
        } catch (err) {
            notes.push(`could not ${settings.originals === "delete" ? "delete" : "move"} the original: ${errorMessage(err)}`);
        }

        // Sidecar video. Discarding only after the original was handled: the video is half
        // of a pair whose other half must be gone (or archived) first. Not knowing means
        // keeping, so any failure leaves the video in place.
        if (job.motion) {
            const name = job.motion.name;
            if (settings.motion === "extract") {
                try {
                    const moved = await rehomeSidecar(job.motion.path, outputPath);
                    notes.push(`kept ${name} as ${basename(moved)}`);
                } catch (err) {
                    notes.push(`could not rename the sidecar video ${name}: ${errorMessage(err)}`);
                }
            } else if (originalHandled) {
                try {
                    await unlink(job.motion.path);
                    notes.push(`removed sidecar video ${name}`);
                } catch (err) {
                    notes.push(`could not delete the sidecar video ${name}: ${errorMessage(err)}`);
                }
            } else {
                notes.push(`kept sidecar video ${name} (original still was not removed)`);
            }
        }
        result.seconds = (performance.now() - started) / 1000;
        return result;
    } finally {
        if (tempIntermediate) await unlink(tempIntermediate).catch(() => {});
    }
}

export async function runConvert(
    jobs: ConvertJob[],
    settings: ConvertSettings,
    onResult: (r: ConvertResult, done: number, total: number) => void,
    signal?: AbortSignal,
): Promise<ConvertSummary> {
    // Preflight. The self-test is fatal: some cjxl builds log that they embedded Exif and
    // write nothing, and losing EXIF is not an acceptable failure mode. It runs for every
    // job, not only those that go through exiftool for the copy: each output's Exif is read
    // back with exiftool too, and when that readback can't work (no Brotli module for the
    // brob box cjxl writes) every photo was encoded and then discarded one by one.
    const cjxl = await checkCjxl(settings.migrateMetadata);
    const exiftool = await exiftoolVersion();
    try {
        await selfTestExifPipeline();
    } catch (err) {
        throw new Error(`EXIF self-test failed, nothing was converted: ${errorMessage(err)}`);
    }
    const selfTest = "passed";

    const results: ConvertResult[] = [];
    const madeDirs = new Set<string>();
    const total = jobs.length;
    const record = (r: ConvertResult) => {
        results.push(r);
        try {
            onResult(r, results.length, total);
        } catch {
            // A throwing listener must not take the batch down.
        }
    };

    await runConcurrent(
        jobs,
        settings.concurrency,
        async job => {
            if (signal?.aborted) {
                record(emptyResult(job, "skipped", "cancelled"));
                return;
            }
            record(await convertOne(job, settings, cjxl.path, madeDirs));
        },
        (job, error) => record(emptyResult(job, "failed", errorMessage(error))),
    );

    const count = (s: ConvertResult["status"]) => results.filter(r => r.status === s).length;
    return {
        results,
        ok: count("ok"),
        failed: count("failed"),
        skipped: count("skipped"),
        inputBytes: results.filter(r => r.status === "ok").reduce((n, r) => n + r.inputBytes, 0),
        outputBytes: results.reduce((n, r) => n + r.outputBytes, 0),
        tools: [
            { label: "cjxl", version: cjxl.version, path: cjxl.path },
            { label: "exiftool", version: exiftool.version, path: exiftool.path },
            { label: "EXIF self-test", version: selfTest, path: "" },
        ],
    };
}
