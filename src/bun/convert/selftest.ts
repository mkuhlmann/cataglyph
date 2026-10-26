// Pre-flight checks: is the cjxl we are about to use new enough, and does the encode +
// metadata-migration pipeline really keep EXIF.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { toolPaths } from "../tools.ts";
import { IMAGE_COPY_ARGS, migrateMetadata } from "./exif.ts";
import { lastLine, run, runQuiet } from "./proc.ts";

// libjxl 0.7.0 is the version with the silent-Exif-loss bug: its cjxl logs that it embedded
// the source Exif on a lossy VarDCT re-encode and writes nothing. Several distros still ship
// it. Refuse to run on it rather than discover the loss later; migrateMetadata is the one way
// to run safely on an old cjxl, since exiftool re-attaches the metadata afterwards and the
// self-test proves it worked, so that combination waives the minimum.
export const MIN_CJXL_VERSION = "0.8.0";
const MIN_CJXL_REASON = "libjxl 0.7.x silently drops Exif on lossy re-encodes";

// Minimal 1x1 JPEG, used by selfTestExifPipeline() to verify (before touching any real
// files) that the active cjxl + exiftool actually preserve EXIF end-to-end. See that function
// for why this can't just be assumed: some cjxl builds silently drop EXIF on lossy re-encodes.
export const SELFTEST_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";

// Dotted numeric comparison, shorter version padded with zeros. Trailing non-numeric junk
// is ignored - only the numbers are compared.
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map(part => parseInt(part, 10) || 0);
    const left = parse(a);
    const right = parse(b);
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

// Actually executes cjxl (a binary that exists but cannot run is a different failure from
// one that is missing) and parses its version. `migrateMetadata` waives the minimum.
export async function checkCjxl(migrateMetadataOn = false): Promise<{ version: string; path: string }> {
    const path = toolPaths().cjxl;
    let result;
    try {
        result = await run([path, "--version"]);
    } catch (err) {
        throw new Error(`cjxl not found or not runnable at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    const version = /v?(\d+\.\d+(?:\.\d+)?)/.exec(combined)?.[1] ?? null;
    if (result.exitCode !== 0 && version === null) {
        throw new Error(`cjxl at ${path} cannot run: ${lastLine(combined) || `exited ${result.exitCode}`}`);
    }
    // An unparseable banner is more likely a new release than a broken install: report it.
    const found = version ?? "unknown";
    if (version !== null && !migrateMetadataOn && compareVersions(version, MIN_CJXL_VERSION) < 0) {
        throw new Error(`cjxl ${version} at ${path} is too old: needs >= ${MIN_CJXL_VERSION}: ${MIN_CJXL_REASON}`);
    }
    return { version: found, path };
}

export async function exiftoolVersion(): Promise<{ version: string; path: string }> {
    const path = toolPaths().exiftool;
    const result = await run([path, "-ver"]).catch(() => null);
    if (!result || result.exitCode !== 0) {
        throw new Error(`exiftool not found or not runnable at ${path}`);
    }
    return { version: result.stdout.trim(), path };
}

// ============================================================================
// EXIF SAFETY: verify the encode + metadata-migration pipeline actually works
// ============================================================================
// Some cjxl builds log that they embedded the source Exif on a lossy re-encode but silently
// write nothing. Rather than trust that, this round-trips a tagged throwaway JPEG through the
// real cjxl + exiftool pipeline before any real file is touched, and throws if the tag
// doesn't survive. Losing EXIF is not an acceptable failure mode here, so this is fatal.
export async function selfTestExifPipeline(): Promise<void> {
    const cjxl = toolPaths().cjxl;
    const exiftool = toolPaths().exiftool;
    const dir = join(tmpdir(), `cataglyph-selftest-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const srcPath = join(dir, "test.jpg");
    const jxlPath = join(dir, "test.jxl");
    const marker = "cataglyph-selftest";

    try {
        await Bun.write(srcPath, Buffer.from(SELFTEST_JPEG_BASE64, "base64"));

        const tagExit = await runQuiet([exiftool, `-Artist=${marker}`, "-overwrite_original", "-q", "-q", srcPath]);
        if (tagExit !== 0) {
            throw new Error(`could not tag the self-test image (exiftool exit ${tagExit})`);
        }

        const cjxlExit = await runQuiet([cjxl, srcPath, jxlPath, "-d", "1.0", "-e", "1", "--lossless_jpeg=0"]);
        if (cjxlExit !== 0) {
            throw new Error(`'${cjxl}' failed to encode the self-test image (exit ${cjxlExit})`);
        }

        const migrateExit = await migrateMetadata(srcPath, jxlPath);
        if (migrateExit !== 0) {
            throw new Error(`exiftool failed to migrate metadata onto the self-test output (exit ${migrateExit})`);
        }

        const read = await run([exiftool, "-s3", "-Artist", jxlPath]);
        const readback = read.stdout.trim();
        if (read.exitCode !== 0 || readback !== marker) {
            // cjxl 0.12 Brotli-compresses the Exif box (brob), and an exiftool whose perl lacks
            // IO::Uncompress::Brotli reads it as empty: on such a host every conversion failed
            // its readback with "got null" and nothing said why.
            const hint = /IO::Uncompress::Brotli/.test(read.stderr)
                ? "; exiftool's perl lacks IO::Uncompress::Brotli (Arch: perl-io-compress-brotli, Debian/Ubuntu: libio-compress-brotli-perl)"
                : "";
            throw new Error(`EXIF did not survive the pipeline (expected "${marker}", got ${JSON.stringify(readback)})${hint}`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}
