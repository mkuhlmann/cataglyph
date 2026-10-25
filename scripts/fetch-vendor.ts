// Fetches the third-party binaries the app bundles, verifying every download against a
// pinned SHA-256 before anything is unpacked. Run once after cloning: `bun run vendor`.
//
//   vendor/jxl/cjxl, djxl, LICENSE.*             libjxl 0.12.0 static release
//   vendor/litert/libLiteRtWebGpuAccelerator.so  LiteRT 2.3.0 GPU accelerator (Dawn -> Vulkan)
//   models/eye.tflite, eye_meta.json, LICENSE.md Eye v1.0.0 weights (skipped when present)
//   vendor/appimage/runtime-x86_64               AppImage type2 runtime (packaging only)
//
// Why each one is vendored rather than taken from the system:
// - cjxl: Ubuntu/Neon ship libjxl 0.7.0, which logs that it embedded Exif on lossy re-encodes
//   and silently writes nothing. See media-batch's jxl-batch for the original finding.
// - The LiteRT accelerator: Eye's native core links LiteRT but ships CPU-only. LiteRT dlopens
//   libLiteRtWebGpuAccelerator.so by name when it is on LD_LIBRARY_PATH, which moves
//   inference onto the GPU (measured on a Radeon 890M: ~115 ms/photo vs ~280 ms on the CPU).
//   The official ai-edge-litert wheel is the only Linux build of it Google publishes.
// - The AppImage runtime: scripts/build-appimage.ts prepends it to a squashfs of the app
//   itself (mksquashfs from squashfs-tools), so packaging needs no appimagetool, which is an
//   AppImage of its own and wants FUSE just to run.
//
// On macOS only the model is fetched: libjxl publishes no macOS binaries (a static cjxl/djxl
// has to be built and put into vendor/jxl/, see docs/macos.md), the accelerator above is a
// Linux .so, and the AppImage runtime is for Linux packaging only.
//
// Each binary keeps the license files it was released with (BSD/Apache notices travel with
// redistributed binaries; the Desert Ant Labs license requires keeping its file with the
// weights), and build-appimage.ts ships them next to the binaries.

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const LIBJXL = {
    url: "https://github.com/libjxl/libjxl/releases/download/v0.12.0/jxl-linux-x86_64-static.tar.lz",
    sha256: "5318a1ea40adad76d023e0c17a03d4627f8282f83cb2b575e69be8e74f1ff456",
};

const LITERT_WHEEL = {
    url: "https://files.pythonhosted.org/packages/94/db/defacfb96eb7ddf6145dc6bc0b0c64bc221364e413662ef8216bae8258e8/ai_edge_litert-2.3.0-cp312-cp312-manylinux_2_27_x86_64.whl",
    sha256: "dc9f56c23e0dcf182b6c35f23fbb102ed048296588882b806d5eff7654c04c88",
    member: "ai_edge_litert/libLiteRtWebGpuAccelerator.so",
    license: "ai_edge_litert-2.3.0.dist-info/licenses/LICENSE",
};

// GitHub publishes no digest for this release asset; the hash pins what was downloaded and
// checked when the release was adopted.
const APPIMAGE_RUNTIME = {
    url: "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
    sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
};

const EYE = {
    base: "https://huggingface.co/desert-ant-labs/eye/resolve/v1.0.0/",
    files: {
        "eye.tflite": "25ba485c959a47961ac9243e74e6ad4997bfc88e1267f62aa88827fc9d92894b",
        "eye_meta.json": null as string | null, // small and text; size-checked only
        "LICENSE.md": "de54a93bae330a39dca2b2dc35b4d8536b3f4a7c3712777e4e10bb6d6754aee7",
    },
};

async function sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
    return hash.digest("hex");
}

async function download(url: string, dest: string, expected: string | null): Promise<void> {
    console.log(`↓ ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await Bun.write(dest, res);
    if (expected) {
        const actual = await sha256(dest);
        if (actual !== expected) {
            await rm(dest, { force: true });
            throw new Error(`${url}: checksum mismatch (expected ${expected}, got ${actual})`);
        }
    }
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
}

async function run(cmd: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error(`${cmd[0]} failed`);
}

// The static release tarball nests the binaries under bin/ (or at the top level, depending on
// the release); search rather than hard-code the layout.
async function findFile(dir: string, name: string): Promise<string | null> {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name);
    }
    return null;
}

async function fetchCjxl(work: string) {
    const out = join(ROOT, "vendor", "jxl");
    if (await exists(join(out, "LICENSE.jpeg-xl"))) return console.log("✓ vendor/jxl/cjxl present");
    const archive = join(work, "jxl.tar.lz");
    await download(LIBJXL.url, archive, LIBJXL.sha256);
    const unpack = join(work, "jxl");
    await mkdir(unpack, { recursive: true });
    await run(["tar", "--lzip", "-xf", archive, "-C", unpack], work);
    await mkdir(out, { recursive: true });
    for (const name of ["cjxl", "djxl"]) {
        const found = await findFile(unpack, name);
        if (!found) throw new Error(`${name} not found in the libjxl release`);
        await copyFile(found, join(out, name));
        await chmod(join(out, name), 0o755);
    }
    // LICENSE.jpeg-xl plus one per statically linked library (brotli, highway, libpng, ...).
    for (const entry of await readdir(unpack)) {
        if (entry.startsWith("LICENSE.")) await copyFile(join(unpack, entry), join(out, entry));
    }
    console.log("✓ vendor/jxl/cjxl, djxl (libjxl 0.12.0)");
}

async function fetchAccelerator(work: string) {
    const out = join(ROOT, "vendor", "litert");
    if (await exists(join(out, "LICENSE"))) {
        return console.log("✓ vendor/litert/libLiteRtWebGpuAccelerator.so present");
    }
    const wheel = join(work, "litert.whl");
    await download(LITERT_WHEEL.url, wheel, LITERT_WHEEL.sha256);
    await run(["unzip", "-q", "-o", wheel, LITERT_WHEEL.member, LITERT_WHEEL.license, "-d", work], work);
    await mkdir(out, { recursive: true });
    await copyFile(join(work, LITERT_WHEEL.member), join(out, "libLiteRtWebGpuAccelerator.so"));
    await copyFile(join(work, LITERT_WHEEL.license), join(out, "LICENSE"));
    console.log("✓ vendor/litert/libLiteRtWebGpuAccelerator.so (LiteRT 2.3.0)");
}

async function fetchAppImageRuntime() {
    const dest = join(ROOT, "vendor", "appimage", "runtime-x86_64");
    if (await exists(dest)) return console.log("✓ vendor/appimage/runtime-x86_64 present");
    await mkdir(join(ROOT, "vendor", "appimage"), { recursive: true });
    await download(APPIMAGE_RUNTIME.url, dest, APPIMAGE_RUNTIME.sha256);
    console.log("✓ vendor/appimage/runtime-x86_64 (type2-runtime 20251108)");
}

async function fetchModel() {
    const out = join(ROOT, "models");
    await mkdir(out, { recursive: true });
    for (const [name, digest] of Object.entries(EYE.files)) {
        const dest = join(out, name);
        if (await exists(dest)) {
            if (digest && await sha256(dest) !== digest) throw new Error(`models/${name}: checksum mismatch`);
            console.log(`✓ models/${name} present`);
            continue;
        }
        await download(EYE.base + name, dest, digest);
        console.log(`✓ models/${name}`);
    }
}

const work = await mkdtemp(join(tmpdir(), "cataglyph-vendor-"));
try {
    if (process.platform === "linux") {
        await fetchCjxl(work);
        await fetchAccelerator(work);
    }
    await fetchModel();
    if (process.platform === "linux") await fetchAppImageRuntime();
    else if (!await exists(join(ROOT, "vendor", "jxl", "cjxl"))) {
        console.log("! vendor/jxl/cjxl missing: build a static libjxl 0.12 (see docs/macos.md); until then cjxl/djxl come from PATH");
    }
} finally {
    await rm(work, { recursive: true, force: true });
}
