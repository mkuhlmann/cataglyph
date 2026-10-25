import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanFolder, shouldMerge } from "../src/bun/scan/scan.ts";

let dir = "";

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ingest-scan-"));
    await mkdir(join(dir, "RAW"));
    await mkdir(join(dir, "originals"));
    await writeFile(join(dir, "RAW", "OLD.ARW"), "x");
    await writeFile(join(dir, "originals", "OLD.JPG"), "x");
    await writeFile(join(dir, "DSC1.JPG"), "not really a jpeg");
    await writeFile(join(dir, "DSC1.ARW"), "x");
    await writeFile(join(dir, "DSC1.ARW.pp3"), "x");
    await writeFile(join(dir, "MOTION.JPG"), "xxxx<x:xmpmeta GCamera:MicroVideo=\"1\" hdrgm:Version=\"1.0\">");
    // Not parseable as video: exiftool cannot read a duration, so it must stay separate.
    await writeFile(join(dir, "IMG_7.HEIC"), "x");
    await writeFile(join(dir, "IMG_7.MOV"), "x");
    await writeFile(join(dir, "readme.txt"), "x");
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("scanFolder", () => {
    test("skips subdirectories and pairs files", async () => {
        const { items, ignored } = await scanFolder(dir);
        const ids = items.map(i => i.id);
        expect(ids).not.toContain("OLD.ARW");
        expect(ids).not.toContain("OLD.JPG");
        const dsc = items.find(i => i.id === "DSC1.JPG");
        expect(dsc?.raw?.name).toBe("DSC1.ARW");
        expect(dsc?.rawSidecars.map(s => s.name)).toEqual(["DSC1.ARW.pp3"]);
        expect(ignored.map(i => i.name)).toEqual(["readme.txt"]);
    });

    test("detects embedded motion and gain map markers", async () => {
        const { items } = await scanFolder(dir);
        const motion = items.find(i => i.id === "MOTION.JPG");
        expect(motion?.embeddedMotion).toBe(true);
        expect(motion?.hasGainMap).toBe(true);
        expect(items.find(i => i.id === "DSC1.JPG")?.embeddedMotion).toBe(false);
    });

    test("an unverifiable same-name video stays a separate item", async () => {
        const { items } = await scanFolder(dir);
        expect(items.find(i => i.id === "IMG_7.HEIC")?.motion).toBeNull();
        expect(items.find(i => i.id === "IMG_7.MOV")?.kind).toBe("video");
    });
});

describe("shouldMerge", () => {
    const path = "/v.mov";
    test("verified merges regardless of duration", () => {
        expect(shouldMerge({ pairing: { kind: "verified", path }, duration: 30 })).toBe(true);
    });
    test("name-only merges only when short", () => {
        expect(shouldMerge({ pairing: { kind: "name-only", path }, duration: 2.5 })).toBe(true);
        expect(shouldMerge({ pairing: { kind: "name-only", path }, duration: 40 })).toBe(false);
        expect(shouldMerge({ pairing: { kind: "name-only", path }, duration: null })).toBe(false);
    });
    test("rejected and unknown never merge", () => {
        expect(shouldMerge({ pairing: { kind: "rejected", path, reason: "" }, duration: 1 })).toBe(false);
        expect(shouldMerge({ pairing: { kind: "unknown", path, reason: "" }, duration: 1 })).toBe(false);
    });
});
