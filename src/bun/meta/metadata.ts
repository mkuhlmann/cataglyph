// Metadata reads through a long-lived exiftool (exiftool-vendored keeps `-stay_open`
// processes around), so a 1000-photo folder costs ~15 ms per file instead of a perl start-up
// each. Writes and the convert pipeline's verification use the CLI in convert/exif.ts; this
// module is read-only.

import { ExifDateTime, ExifTool, type Tags } from "exiftool-vendored";

let et: ExifTool | null = null;

function tool(): ExifTool {
    et ??= new ExifTool({ maxProcs: 4, taskTimeoutMillis: 30_000 });
    return et;
}

export async function shutdownMetadata() {
    await et?.end();
    et = null;
}

export interface Basics {
    /** Seconds since the epoch, sub-second precise when the camera wrote SubSecTime. */
    captureTime: number | null;
    /** Upright size (Orientation 5-8 swap width and height). */
    width: number;
    height: number;
}

// Capture time is what Eye.duplicates uses to decide whether two similar frames are a
// burst, so sub-second precision matters: the A7CR shoots 8 fps, and two frames 120 ms apart
// with DateTimeOriginal alone would tie.
function captureSeconds(tags: Tags): number | null {
    for (const value of [tags.SubSecDateTimeOriginal, tags.DateTimeOriginal, tags.CreateDate, tags.MediaCreateDate]) {
        if (value instanceof ExifDateTime) {
            const ms = value.toMillis();
            if (ms !== undefined && Number.isFinite(ms)) return ms / 1000;
        }
    }
    return null;
}

export async function readBasics(path: string): Promise<Basics> {
    const tags = await tool().read(path, { readArgs: ["-fast2"] });
    let width = Number(tags.ImageWidth ?? 0);
    let height = Number(tags.ImageHeight ?? 0);
    const orientation = Number(tags.Orientation ?? 1);
    if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
    return { captureTime: captureSeconds(tags), width, height };
}

/**
 * Rows for the detail panel, in display order, as [label key, value]. The view translates the
 * key (`meta.<key>`); missing values are left out.
 */
export type MetaRow = [label: string, value: string];

const fmt = (v: unknown): string | null => {
    if (v === undefined || v === null || v === "") return null;
    if (v instanceof ExifDateTime) return v.toDateTime()?.toFormat("yyyy-LL-dd HH:mm:ss") ?? v.toString();
    return String(v);
};

export async function readDetails(path: string): Promise<{ rows: MetaRow[]; gps: { lat: number; lon: number } | null }> {
    const t = await tool().read(path);
    const any = t as Record<string, unknown>;
    const exposure = [
        fmt(t.FNumber) && `f/${fmt(t.FNumber)}`,
        fmt(t.ExposureTime) && `${fmt(t.ExposureTime)} s`,
        fmt(t.ISO) && `ISO ${fmt(t.ISO)}`,
    ].filter(Boolean).join(" · ");
    const rows: [string, string | null][] = [
        ["captured", fmt(t.SubSecDateTimeOriginal ?? t.DateTimeOriginal ?? t.CreateDate)],
        ["camera", [fmt(t.Make), fmt(t.Model)].filter(Boolean).join(" ") || null],
        ["lens", fmt(t.LensModel ?? any.LensID ?? any.Lens)],
        ["focalLength", fmt(t.FocalLength)],
        ["exposure", exposure || null],
        ["exposureComp", fmt(any.ExposureCompensation)],
        ["program", fmt(any.ExposureProgram)],
        ["metering", fmt(any.MeteringMode)],
        ["whiteBalance", fmt(any.WhiteBalance)],
        ["flash", fmt(any.Flash)],
        ["focus", fmt(any.FocusMode)],
        ["resolution", t.ImageWidth && t.ImageHeight ? `${t.ImageWidth} × ${t.ImageHeight}` : null],
        ["megapixels", fmt(any.Megapixels)],
        ["colorSpace", fmt(any.ColorSpace ?? any.ProfileDescription)],
        ["duration", fmt(any.Duration)],
        ["videoCodec", fmt(any.CompressorID ?? any.VideoCodec)],
        ["software", fmt(t.Software)],
        ["rating", fmt(t.Rating)],
        ["fileSize", fmt(t.FileSize)],
    ];
    const lat = typeof t.GPSLatitude === "number" ? t.GPSLatitude : null;
    const lon = typeof t.GPSLongitude === "number" ? t.GPSLongitude : null;
    if (lat !== null && lon !== null) rows.push(["gps", `${lat.toFixed(5)}, ${lon.toFixed(5)}`]);
    return {
        rows: rows.filter((r): r is MetaRow => r[1] !== null),
        gps: lat !== null && lon !== null ? { lat, lon } : null,
    };
}

/**
 * Writes a RAW's embedded JPEG to `dest`. Prefers the full-size JpgFromRaw (Sony ARW: 9504 px,
 * ~5 MB) over the small PreviewImage, since this is also what Eye analyses for raw-only items.
 */
export async function extractRawPreview(rawPath: string, dest: string): Promise<void> {
    try {
        await tool().extractJpgFromRaw(rawPath, dest);
        return;
    } catch {
        // DNGs from phones usually carry only PreviewImage; fall through.
    }
    await tool().extractPreview(rawPath, dest);
}
