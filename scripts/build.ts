// Builds the app into build/app/, the directory Electron runs: `bun run build`.
//
//   build/app/package.json         name, version and the Electron entry point
//   build/app/electron/main.js     Electron main process (window, native services, relay)
//   build/app/electron/preload.cjs the view's bridge to the main process
//   build/app/bun/index.js         the Bun process: sessions, media server, Eye, apply, convert
//   build/app/view/                the Vue view (vite build)
//   build/app/icon.png             window icon on Linux
//
// The dev run starts Electron on this directory as it is; scripts/package.ts copies it into a
// packaged app and adds node_modules, vendor/, models/ and a bun binary. Both resolve those by
// walking up from build/app/bun/ (tools.ts and module resolution), so a dev run finds them in
// the project root.

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const APP = join(ROOT, "build", "app");

// Loaded from node_modules at runtime rather than bundled: Eye's prebuilt LiteRT core and koffi
// locate their .so/.node files relative to their own package directory, exiftool-vendored
// finds its Perl script the same way, and libheif-js loads its wasm next to itself.
export const EXTERNAL = ["@desert-ant-labs/eye", "@desert-ant-labs/core", "koffi", "exiftool-vendored", "libheif-js"];

async function run(cmd: string[]): Promise<void> {
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function bundle(entry: string, outfile: string, options: Partial<Parameters<typeof Bun.build>[0]>) {
    const result = await Bun.build({ entrypoints: [join(ROOT, entry)], sourcemap: "linked", ...options });
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        throw new Error(`bundling ${entry} failed`);
    }
    const [output] = result.outputs;
    if (!output) throw new Error(`bundling ${entry} produced no output`);
    await Bun.write(join(APP, outfile), output);
    const map = result.outputs.find(o => o.kind === "sourcemap");
    if (map) await Bun.write(join(APP, `${outfile}.map`), map);
}

export async function build() {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as { version: string; description: string };
    await rm(APP, { recursive: true, force: true });
    await mkdir(APP, { recursive: true });

    await run(["bunx", "vite", "build", "--logLevel", "warn"]);
    // The main process runs in Electron's Node, so it is bundled for node with electron left as
    // the runtime's own module. The preload is CommonJS: a sandboxed renderer can't load an ESM
    // preload.
    await bundle("src/electron/main.ts", "electron/main.js", { target: "node", format: "esm", external: ["electron"] });
    await bundle("src/electron/preload.ts", "electron/preload.cjs", { target: "node", format: "cjs", external: ["electron"] });
    await bundle("src/bun/index.ts", "bun/index.js", { target: "bun", format: "esm", external: EXTERNAL });

    await writeFile(join(APP, "package.json"), JSON.stringify({
        name: "cataglyph",
        productName: "Cataglyph",
        version: pkg.version,
        description: pkg.description,
        license: "MIT",
        type: "module",
        main: "electron/main.js",
    }, null, 4) + "\n");
    await copyFile(join(ROOT, "assets", "cataglyph.png"), join(APP, "icon.png"));
}

if (import.meta.main) {
    await build();
    console.log(`✓ ${APP}`);
}
