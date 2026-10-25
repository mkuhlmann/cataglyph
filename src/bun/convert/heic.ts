// HEIC/HEIF -> temporary 8-bit PPM that cjxl can read.
//
// cjxl cannot read HEIC, and the original jxl-batch shelled out to ImageMagick for this. The
// app must not depend on a system ImageMagick, so the decode runs in-process with libheif
// compiled to wasm (libheif-js' `wasm-bundle`, which embeds the .wasm in the JS so it needs
// no file lookup and survives being bundled next to the main script).
//
// The decoded raster carries no metadata at all - EXIF, XMP and the ICC profile are all
// gone - which is why the caller ALWAYS runs the exiftool migration on HEIC outputs and
// treats a failure as fatal. libheif applies the container's rotation/mirror transforms
// while decoding, so the pixels are already upright (see jxl.ts for the Orientation reset
// that keeps the copied EXIF from rotating them a second time).
//
// If the wasm bundle cannot be loaded at all, falls back to the system `heif-convert`
// (libheif-examples) writing a PNG, which cjxl also reads.

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runQuiet } from "./proc.ts";

interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
        target: { data: Uint8ClampedArray; width: number; height: number },
        done: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
    ): void;
}
interface HeifLib {
    HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
}

let libPromise: Promise<HeifLib> | null = null;

function loadLib(): Promise<HeifLib> {
    // A dynamic import of a CommonJS module: the bundle's export is the ready-to-use lib.
    // @ts-expect-error libheif-js ships no type declarations; HeifLib above is the used subset.
    libPromise ??= import("libheif-js/wasm-bundle").then(m => (m.default ?? m) as unknown as HeifLib);
    return libPromise;
}

// Builds a binary P6 PPM from RGBA: alpha is dropped (JPEG XL from a PPM has none, and HEIC
// stills from phones have no meaningful alpha).
export function rgbaToPpm(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
    const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
    const out = new Uint8Array(header.length + width * height * 3);
    out.set(header, 0);
    let o = header.length;
    for (let i = 0; i < width * height; i++) {
        out[o++] = rgba[i * 4]!;
        out[o++] = rgba[i * 4 + 1]!;
        out[o++] = rgba[i * 4 + 2]!;
    }
    return out;
}

/** Decoded, upright RGBA pixels of the primary image. Also used for gallery previews. */
export async function decodeHeicRgba(inputPath: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
    const lib = await loadLib();
    const data = new Uint8Array(await Bun.file(inputPath).arrayBuffer());
    const images = new lib.HeifDecoder().decode(data);
    const image = images[0];
    if (!image) throw new Error("HEIC decode failed: no image in file");
    const width = image.get_width();
    const height = image.get_height();
    const shown = await new Promise<{ data: Uint8ClampedArray } | null>(resolve => {
        image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, resolve);
    });
    if (!shown) throw new Error("HEIC decode failed: libheif could not render the image");
    return { data: shown.data, width, height };
}

async function decodeWasm(inputPath: string, outPath: string): Promise<void> {
    const { data, width, height } = await decodeHeicRgba(inputPath);
    await Bun.write(outPath, rgbaToPpm(data, width, height));
}

/**
 * Decodes `inputPath` to a temporary raster and returns its path. The caller owns the file
 * and must delete it (jxl.ts does so in a `finally`).
 */
export async function decodeHeicToTemp(inputPath: string): Promise<string> {
    const id = crypto.randomUUID();
    let lib: HeifLib | null = null;
    try {
        lib = await loadLib();
    } catch {
        libPromise = null;
    }

    if (lib) {
        const ppm = join(tmpdir(), `cataglyph-heic-${id}.ppm`);
        try {
            await decodeWasm(inputPath, ppm);
            return ppm;
        } catch (err) {
            await unlink(ppm).catch(() => {});
            throw err;
        }
    }

    const png = join(tmpdir(), `cataglyph-heic-${id}.png`);
    const exit = await runQuiet(["heif-convert", inputPath, png]).catch(() => -1);
    if (exit !== 0) {
        await unlink(png).catch(() => {});
        throw new Error(`HEIC decode failed (libheif-js unavailable, heif-convert exit ${exit})`);
    }
    return png;
}
