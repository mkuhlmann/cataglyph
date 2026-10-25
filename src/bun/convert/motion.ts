// Motion photos / live photos: a still that has a short video attached to it.
//
// Pairing and classification (verified Live Photo vs. a video that merely shares the
// basename) live in scan/; the convert job receives the already-verified sidecar. What is
// left here is what happens to the video during conversion.
//
// Two layouts exist and they need different handling:
//
//   * Apple Live Photos, and some Android exports, keep the video as a SEPARATE file with
//     the same basename (IMG_4021.HEIC + IMG_4021.MOV). Converting the still and leaving
//     that file behind orphans it permanently - its partner is now a .jxl it will never be
//     paired with again. So it is either renamed to follow the output or discarded.
//
//   * Google/Samsung motion photos EMBED the MP4 in the JPEG itself, appended after the
//     image data and announced through XMP (GCamera:MicroVideo* on older files,
//     Container/GContainer directory entries with a MotionPhoto semantic on newer ones).
//     cjxl only reads the image, so the payload is dropped on its own - but in lossless
//     mode cjxl carries the source XMP across, which leaves the output advertising a video
//     at a byte offset that no longer exists. Gallery apps read exactly those tags, badge
//     the file as a motion photo and then fail to play it, so they have to be stripped.
//
// Nothing here can produce a *working* motion photo on the output side: no gallery app
// implements motion-photo playback for JPEG XL, so re-embedding the payload in a .jxl
// would only be a private convention that nothing but this tool could read. Carrying the
// video over therefore means writing it out as a normal video file next to the output.

import { rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { toolPaths } from "../tools.ts";
import { runQuiet } from "./proc.ts";

// XMP groups that describe the embedded video. Cleared from the output when the payload is
// gone. Not in exif.ts's copy allowlist either, so migrateMetadata never re-adds them.
const MOTION_XMP_GROUPS = [
    "-XMP-GCamera:all=",
    "-XMP-Container:all=",
    "-XMP-GContainer:all=",
];

// Where a sidecar video lands when it follows the converted still.
export function rehomedPath(videoPath: string, outputPath: string): string {
    return join(
        dirname(outputPath),
        `${basename(outputPath, extname(outputPath))}${extname(videoPath)}`,
    );
}

// Moves a sidecar video next to the converted still and renames it to match, so the pair
// survives deleting the original intact instead of the video being orphaned under the old
// basename. Never clobbers: an existing file at the target throws, and the caller keeps the
// video where it is.
export async function rehomeSidecar(videoPath: string, outputPath: string): Promise<string> {
    const target = rehomedPath(videoPath, outputPath);
    if (target !== videoPath) {
        if (await stat(target).then(() => true, () => false)) {
            throw new Error(`${basename(target)} already exists`);
        }
        await rename(videoPath, target);
    }
    return target;
}

// Writes the embedded MP4 out as its own file next to the converted still.
//
// exiftool's -Trailer knows where the image data ends for both the MicroVideo and the
// Container layouts, which beats re-deriving the boundary from the XMP offsets by hand
// (and beats scanning for an EOI marker, since the MP4 payload can contain those bytes).
// The result is checked for an `ftyp` box before it is written, so a format change upstream
// produces no file rather than a plausible-looking broken one.
export async function extractMotionVideo(stillPath: string, destPath: string): Promise<{ ok: boolean; bytes: number; reason?: string }> {
    const proc = Bun.spawn([toolPaths().exiftool, "-b", "-Trailer", stillPath], { stdout: "pipe", stderr: "ignore" });
    const payload = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        return { ok: false, bytes: 0, reason: `exiftool could not read the trailer (exit ${exitCode})` };
    }
    if (payload.length === 0) {
        return { ok: false, bytes: 0, reason: "no trailer data found" };
    }
    // Every MP4/MOV starts with a 4-byte size followed by the 'ftyp' box type.
    const magic = new TextDecoder().decode(payload.slice(4, 8));
    if (magic !== "ftyp") {
        return { ok: false, bytes: 0, reason: `trailer is not an MP4 (expected an ftyp box, got ${JSON.stringify(magic)})` };
    }

    await Bun.write(destPath, payload);
    return { ok: true, bytes: payload.length };
}

// Clears the motion-photo XMP from a converted file whose payload did not survive the
// encode. Returns exiftool's exit code; a failure here is cosmetic (stale tags, no data
// loss) and callers treat it as a warning.
export async function stripMotionMetadata(outputPath: string): Promise<number> {
    return await runQuiet([
        toolPaths().exiftool, ...MOTION_XMP_GROUPS, "-overwrite_original", "-m", "-q", "-q", outputPath,
    ]);
}
