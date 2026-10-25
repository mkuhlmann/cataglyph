// Metadata migration via exiftool.
//
// An explicit allowlist of metadata groups, NOT "-all:all". Some phones stuff huge
// proprietary binary blobs into otherwise-normal-looking tags (e.g. Google Camera's
// XMP-GCamera:HdrPlusMakernote, a 60KB+ HDR merge blob written via XMP, split across
// "ExtendedXMP" segments in the source JPEG since it exceeds one APP1 segment). JXL has no
// segment-size limit so "-all:all" dumps the whole thing into a single XMP box as one giant
// base64 blob, which bloats the file and broke Gwenview's metadata display entirely (it read
// as "no EXIF" even though exiftool could still read the real EXIF underneath just fine).
//
// The allowlist covers the human-authored/standard groups - camera, lens, exposure, GPS,
// dates, captions, keywords, ratings, copyright - and excludes MakerNotes and vendor XMP
// extensions (GCamera, multi-picture secondary images, and so on).

import { toolPaths } from "../tools.ts";
import { run, runQuiet } from "./proc.ts";

// Human-authored descriptive metadata.
const DESCRIPTIVE_GROUPS = [
    "-XMP-dc:all", "-XMP-xmp:all", "-XMP-photoshop:all", "-XMP-iptcCore:all", "-IPTC:all",
];

// XMP-lr holds Lightroom's hierarchical keywords, which only ever exist on stills.
export const IMAGE_COPY_ARGS = ["-EXIF:all", ...DESCRIPTIVE_GROUPS, "-XMP-lr:all"];

// Returns exiftool's exit code; callers decide whether a failure is fatal. Here it is fatal
// (the intermediate raster step for HEIC drops everything, so a failure means metadata is
// genuinely lost) and the caller discards the output.
export async function migrateMetadata(from: string, to: string): Promise<number> {
    return await runQuiet([
        toolPaths().exiftool, "-TagsFromFile", from, ...IMAGE_COPY_ARGS,
        "-overwrite_original", "-m", "-q", "-q", to,
    ]);
}

export interface ReadBack {
    DateTimeOriginal?: string;
    Model?: string;
}

// The two tags used to prove metadata survived: capture time and camera model. Values are
// coerced to strings because exiftool's JSON emits numeric-looking values as numbers.
// A file exiftool cannot read yields {} (and so "nothing to compare"), which the caller
// pairs with the exit of the encode itself; unreadable *output* is caught by the size check.
export async function readBack(path: string): Promise<ReadBack> {
    const { stdout } = await run([toolPaths().exiftool, "-json", "-DateTimeOriginal", "-Model", path]);
    try {
        const entry = (JSON.parse(stdout) as Array<Record<string, unknown>>)[0];
        const out: ReadBack = {};
        if (entry?.DateTimeOriginal !== undefined) out.DateTimeOriginal = String(entry.DateTimeOriginal);
        if (entry?.Model !== undefined) out.Model = String(entry.Model);
        return out;
    } catch {
        return {};
    }
}
