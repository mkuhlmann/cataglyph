// Builds the app and runs it in Electron: `bun run dev`. With `--hmr`, the view comes from the
// Vite dev server instead (edits to src/view apply live; changes to src/bun or src/electron
// still need a restart).

import { join, resolve } from "node:path";

import electron from "electron";

import { APP, build } from "./build.ts";

const ROOT = resolve(import.meta.dir, "..");
const hmr = process.argv.includes("--hmr");

// Chromium's sandbox needs either a setuid-root chrome-sandbox (not the case in
// node_modules) or unprivileged user namespaces, which Ubuntu 24.04+ restricts through
// AppArmor. Electron then aborts on start ("The SUID sandbox helper binary was found, but is
// not configured correctly"), and appending the switch from main.js is too late for it.
async function sandboxArgs(): Promise<string[]> {
    if (process.platform !== "linux") return [];
    const read = (path: string) => Bun.file(path).text().then(s => s.trim(), () => "");
    const restricted = await read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1"
        || await read("/proc/sys/kernel/unprivileged_userns_clone") === "0";
    return restricted ? ["--no-sandbox"] : [];
}

await build();

const env: Record<string, string | undefined> = { ...process.env };
let vite: ReturnType<typeof Bun.spawn> | null = null;
if (hmr) {
    vite = Bun.spawn(["bunx", "vite", "--port", "5173"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    env.CATAGLYPH_DEV_SERVER = "http://localhost:5173";
}

const app = Bun.spawn([electron as unknown as string, ...await sandboxArgs(), APP], {
    cwd: join(ROOT),
    env,
    stdout: "inherit",
    stderr: "inherit",
});
const code = await app.exited;
vite?.kill();
process.exit(code);
