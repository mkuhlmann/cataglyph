// Locating the binaries and libraries the app ships with.
//
// Everything external lives in `vendor/` (fetched and checksum-verified by
// scripts/fetch-vendor.ts) or in node_modules, and is copied into the app by
// scripts/package.ts. At runtime the same relative path has to resolve both in a dev run
// (project root) and in a packaged build (next to the bundled main script), so every lookup
// walks a short list of candidate roots instead of assuming one layout.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Candidate roots, most specific first: every ancestor of the running script (the bundle's
// resources sit a few levels above the built main script; a dev build lives under the
// project's build/ folder, so walking up eventually reaches the project root), then cwd.
function candidateRoots(): string[] {
    const roots: string[] = [];
    let dir = import.meta.dir;
    for (;;) {
        roots.push(dir);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    roots.push(resolve(process.cwd()));
    return roots;
}

/** Absolute path of a shipped resource (e.g. "vendor/jxl/cjxl"), or null if none is found. */
export function findResource(relPath: string): string | null {
    for (const root of candidateRoots()) {
        const candidate = join(root, relPath);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

export interface ToolPaths {
    /** Vendored static cjxl (libjxl 0.12): distro libjxl 0.7.0 silently drops Exif. */
    cjxl: string;
    /** Vendored djxl from the same release: Bun.Image can't read JPEG XL. */
    djxl: string;
    /** The Perl exiftool that exiftool-vendored ships; needs only the system perl. */
    exiftool: string;
    /** Directory holding libLiteRtWebGpuAccelerator.so, or null (CPU only). */
    litertAcceleratorDir: string | null;
    /** Directory holding eye.tflite + eye_meta.json. */
    modelDir: string | null;
    /** ffmpeg for video poster frames; system binary, optional. */
    ffmpeg: string | null;
}

let cached: ToolPaths | null = null;

export function toolPaths(): ToolPaths {
    if (cached) return cached;
    const accel = findResource("vendor/litert/libLiteRtWebGpuAccelerator.so");
    const model = findResource("models/eye.tflite");
    cached = {
        cjxl: findResource("vendor/jxl/cjxl") ?? "cjxl",
        djxl: findResource("vendor/jxl/djxl") ?? "djxl",
        exiftool: findResource("node_modules/exiftool-vendored.pl/bin/exiftool") ?? "exiftool",
        litertAcceleratorDir: accel ? dirname(accel) : null,
        modelDir: model ? dirname(model) : null,
        ffmpeg: Bun.which("ffmpeg"),
    };
    return cached;
}
