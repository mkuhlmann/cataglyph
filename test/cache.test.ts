import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearDir, dirUsage } from "../src/bun/store/cache.ts";
import type { AnalysisSummary } from "../src/shared/types.ts";

// db.ts adopts legacy dirs under XDG_* when it loads; point those at a scratch dir so the
// test never renames anything in the real ~/.cache or ~/.local/share.
const xdg = await mkdtemp(join(tmpdir(), "cache-test-xdg-"));
for (const name of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) process.env[name] = xdg;
const { Store } = await import("../src/bun/store/db.ts");

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cache-test-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
    await rm(xdg, { recursive: true, force: true });
});

describe("cache dirs", () => {
    test("counts and clears plain files, leaves writes in progress and subdirectories", async () => {
        await writeFile(join(dir, "a.thumb.webp"), "1234");
        await writeFile(join(dir, "a.preview.webp"), "123456");
        await writeFile(join(dir, "b.thumb.webp.4711.tmp"), "half");
        await mkdir(join(dir, "nested"));
        await writeFile(join(dir, "nested", "x"), "x");

        expect(await dirUsage(dir)).toEqual({ bytes: 10, count: 2 });
        expect(await clearDir(dir)).toEqual({ bytes: 10, count: 2 });
        expect(await dirUsage(dir)).toEqual({ bytes: 0, count: 0 });
        expect(existsSync(join(dir, "b.thumb.webp.4711.tmp"))).toBe(true);
        expect(existsSync(join(dir, "nested", "x"))).toBe(true);
        expect(existsSync(dir)).toBe(true);
    });

    test("a missing directory is empty", async () => {
        expect(await dirUsage(join(dir, "nope"))).toEqual({ bytes: 0, count: 0 });
        expect(await clearDir(join(dir, "nope"))).toEqual({ bytes: 0, count: 0 });
    });
});

describe("Store cache", () => {
    test("clearCache drops analyses and basics but keeps decisions", () => {
        const store = new Store(join(dir, "cache.db"), join(dir, "state.db"));
        try {
            store.putAnalysis("k1", "m", {} as AnalysisSummary, "{}");
            store.putAnalysis("k2", "m", {} as AnalysisSummary, "{}");
            store.putBasics("k1", { captureTime: 1, width: 2, height: 3 });
            store.putDecisions("/f", { a: { verdict: "delete", source: "manual", keepRaw: false } });
            expect(store.cacheUsage().count).toBe(2);

            store.clearCache();
            expect(store.cacheUsage().count).toBe(0);
            expect(store.cacheUsage().bytes).toBeGreaterThan(0);
            expect(store.getBasics("k1")).toBeNull();
            expect(store.getDecisions("/f").a?.verdict).toBe("delete");
        } finally {
            store.close();
        }
    });
});
