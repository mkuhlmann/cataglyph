// Thumbnails and previews for the gallery, cached on disk by content key.
//
// Every item is first reduced to a "display source" that Bun.Image can read:
//   jpg/png          the file itself (libjpeg-turbo shrinks on load, ~90 ms for 61 MP -> 480 px)
//   heic/heif        decoded with libheif-js, cached as a full-size JPEG once
//   jxl (archived)   decoded with the vendored djxl, cached as a full-size JPEG once
//   raw-only         the RAW's embedded JPEG (exiftool), cached once
//   video            a poster frame from ffmpeg, cached once
// The same display source is what Eye analyses, so a HEIC or a ProRAW DNG is decoded once for
// both purposes.

import { mkdirSync } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { Item } from "../../shared/types.ts";
import { decodeHeicRgba } from "../convert/heic.ts";
import { lastLine, run } from "../convert/proc.ts";
import { extractRawPreview } from "../meta/metadata.ts";
import { CACHE_DIR } from "../store/db.ts";
import { toolPaths } from "../tools.ts";

export const THUMB_DIR = join(CACHE_DIR, "thumbs");
mkdirSync(THUMB_DIR, { recursive: true });

export type Variant = "thumb" | "preview";
const EDGE: Record<Variant, number> = { thumb: 480, preview: 2560 };
const QUALITY: Record<Variant, number> = { thumb: 78, preview: 88 };

const DIRECT = new Set(["jpg", "jpeg", "png", "webp"]);

function keyName(contentKey: string): string {
    return new Bun.CryptoHasher("sha1").update(contentKey).digest("hex");
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(s => s.size > 0, () => false);
}

// One in-flight promise per output path: the grid requests the same thumbnail again while it
// scrolls, and the analyser asks for the same display source the grid is already building.
const inflight = new Map<string, Promise<string>>();

function once(path: string, build: (tmp: string) => Promise<void>): Promise<string> {
    const running = inflight.get(path);
    if (running) return running;
    const task = (async () => {
        if (await exists(path)) return path;
        // Written under a temporary name and renamed, so a crash mid-write never leaves a
        // truncated file that `exists` would then serve forever.
        const tmp = `${path}.${process.pid}.tmp`;
        try {
            await build(tmp);
            await rename(tmp, path);
        } finally {
            await unlink(tmp).catch(() => {});
        }
        return path;
    })().finally(() => inflight.delete(path));
    inflight.set(path, task);
    return task;
}

// 24-bit top-down BMP: the one uncompressed format Bun.Image decodes, which makes it the
// cheapest way to hand it raw pixels (it has no raw-pixel input).
function rgbaToBmp(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
    const row = Math.ceil((width * 3) / 4) * 4;
    const size = 54 + row * height;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    out[0] = 0x42;
    out[1] = 0x4d;
    v.setUint32(2, size, true);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, width, true);
    v.setInt32(22, -height, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 24, true);
    for (let y = 0; y < height; y++) {
        let o = 54 + y * row;
        let i = y * width * 4;
        for (let x = 0; x < width; x++, i += 4) {
            out[o++] = rgba[i + 2]!;
            out[o++] = rgba[i + 1]!;
            out[o++] = rgba[i]!;
        }
    }
    return out;
}

/** A path Bun.Image can decode that shows the item upright. */
export async function displaySource(item: Item): Promise<string> {
    const ext = item.primary.ext;
    if (item.kind === "photo" && DIRECT.has(ext)) return item.primary.path;

    const base = join(THUMB_DIR, `${keyName(item.contentKey)}.src.jpg`);
    if (item.kind === "raw-only") {
        return once(base, tmp => extractRawPreview(item.primary.path, tmp));
    }
    if (item.kind === "archived") {
        // Bun.Image doesn't read JPEG XL. djxl decodes a 61 MP lossy file in ~0.7 s and
        // applies the codestream orientation, so the JPEG comes out upright with Orientation 1.
        // `--downsampling` would be cheaper but doesn't shrink non-progressive files (all of
        // cjxl's default output), so it decodes full size and Bun.Image shrinks from there.
        // The temp name keeps the .jpg extension: djxl picks its output format by it.
        return once(base, async tmp => {
            const out = `${tmp}.jpg`;
            try {
                const r = await run([toolPaths().djxl, item.primary.path, out, "--quiet"]);
                if (r.exitCode !== 0) throw new Error(`djxl exited ${r.exitCode}: ${lastLine(r.stderr)}`);
                await rename(out, tmp);
            } finally {
                await unlink(out).catch(() => {});
            }
        });
    }
    if (item.kind === "video") {
        const ffmpeg = toolPaths().ffmpeg;
        if (!ffmpeg) throw new Error("ffmpeg not installed: no poster frame for videos");
        return once(base, async tmp => {
            // 1 s in skips the black first frame many phones record; -ss before -i seeks fast.
            for (const at of ["1", "0"]) {
                const proc = Bun.spawn([ffmpeg, "-v", "error", "-ss", at, "-i", item.primary.path, "-frames:v", "1", "-q:v", "3", "-f", "image2", "-y", tmp], { stdout: "ignore", stderr: "ignore" });
                if (await proc.exited === 0 && await exists(tmp)) return;
            }
            throw new Error("ffmpeg could not extract a frame");
        });
    }
    // heic/heif (and any other still Bun.Image can't read on Linux)
    return once(base, async tmp => {
        const { data, width, height } = await decodeHeicRgba(item.primary.path);
        await new Bun.Image(rgbaToBmp(data, width, height)).jpeg({ quality: 92 }).write(tmp);
    });
}

/** Path of a cached WebP of the given variant, building it if needed. */
export async function variant(item: Item, which: Variant): Promise<string> {
    const out = join(THUMB_DIR, `${keyName(item.contentKey)}.${which}.webp`);
    return once(out, async tmp => {
        const src = await displaySource(item);
        const edge = EDGE[which];
        await new Bun.Image(src)
            .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: QUALITY[which] })
            .write(tmp);
    });
}

/** Upright size of the display source, for items whose metadata had none (videos, HEIC). */
export async function sourceSize(item: Item): Promise<{ width: number; height: number }> {
    const img = new Bun.Image(await displaySource(item));
    const meta = await img.metadata();
    return { width: meta.width, height: meta.height };
}
