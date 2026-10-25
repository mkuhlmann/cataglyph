import { describe, expect, test } from "bun:test";

import { pairFiles } from "../src/bun/scan/pairing.ts";
import type { MediaFile } from "../src/shared/types.ts";

const DIR = "/photos";

function f(name: string): MediaFile {
    const dot = name.lastIndexOf(".");
    return { path: `${DIR}/${name}`, name, ext: name.slice(dot + 1).toLowerCase(), size: 100, mtimeMs: 1000.4 };
}

const pair = (...names: string[]) => pairFiles(names.map(f), DIR);

describe("pairFiles", () => {
    test("Sony JPG + ARW + ARW.pp3", () => {
        const { items, ignored } = pair("DSC00153.JPG", "DSC00153.ARW", "DSC00153.ARW.pp3");
        expect(items).toHaveLength(1);
        const item = items[0]!;
        expect(item.kind).toBe("photo");
        expect(item.id).toBe("DSC00153.JPG");
        expect(item.primary.name).toBe("DSC00153.JPG");
        expect(item.raw?.name).toBe("DSC00153.ARW");
        expect(item.rawSidecars.map(s => s.name)).toEqual(["DSC00153.ARW.pp3"]);
        expect(item.primarySidecars).toEqual([]);
        expect(item.contentKey).toBe("DSC00153.JPG:100:1000");
        expect(ignored).toEqual([]);
    });

    test("case variants and stem sidecar goes to the RAW", () => {
        const { items } = pair("dsc1.jpg", "DSC1.arw", "DSC1.XMP", "dsc1.JPG.xmp");
        expect(items).toHaveLength(1);
        expect(items[0]!.raw?.name).toBe("DSC1.arw");
        expect(items[0]!.rawSidecars.map(s => s.name)).toEqual(["DSC1.XMP"]);
        expect(items[0]!.primarySidecars.map(s => s.name)).toEqual(["dsc1.JPG.xmp"]);
    });

    test("stem sidecar without RAW goes to the primary", () => {
        const { items } = pair("IMG_1.jpg", "IMG_1.xmp");
        expect(items[0]!.primarySidecars.map(s => s.name)).toEqual(["IMG_1.xmp"]);
    });

    test("Pixel RAW-01 / RAW-02 pair", () => {
        const { items } = pair("PXL_20260101_123456789.RAW-01.MP.COVER.jpg", "PXL_20260101_123456789.RAW-02.ORIGINAL.dng");
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("photo");
        expect(items[0]!.raw?.ext).toBe("dng");
    });

    test("Pixel motion photo stays a single photo", () => {
        const { items } = pair("PXL_20260101_123456789.MP.jpg");
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("photo");
        expect(items[0]!.raw).toBeNull();
    });

    test("iPhone HEIC + MOV is a live candidate and a separate video item", () => {
        const { items, liveCandidates } = pair("IMG_1234.HEIC", "IMG_1234.MOV");
        expect(items.map(i => [i.id, i.kind])).toEqual([["IMG_1234.HEIC", "photo"], ["IMG_1234.MOV", "video"]]);
        expect(items[0]!.motion).toBeNull();
        expect(liveCandidates).toHaveLength(1);
        expect(liveCandidates[0]!.itemId).toBe("IMG_1234.HEIC");
        expect(liveCandidates[0]!.video.name).toBe("IMG_1234.MOV");
    });

    test("ProRAW DNG alone is raw-only", () => {
        const { items } = pair("IMG_9.DNG");
        expect(items[0]!.kind).toBe("raw-only");
        expect(items[0]!.primary.name).toBe("IMG_9.DNG");
        expect(items[0]!.raw).toBeNull();
    });

    test("Samsung jpg + dng", () => {
        const { items } = pair("20260101_123456.jpg", "20260101_123456.dng");
        expect(items).toHaveLength(1);
        expect(items[0]!.raw?.name).toBe("20260101_123456.dng");
    });

    test("JPG + HEIC with the same stem become two items, RAW pairs with the JPG", () => {
        const { items } = pair("IMG_1.JPG", "IMG_1.HEIC", "IMG_1.DNG");
        expect(items).toHaveLength(2);
        const jpg = items.find(i => i.primary.ext === "jpg")!;
        const heic = items.find(i => i.primary.ext === "heic")!;
        expect(jpg.raw?.ext).toBe("dng");
        expect(heic.raw).toBeNull();
    });

    test("orphan sidecar is ignored", () => {
        const { items, ignored } = pair("A.jpg", "B.ARW.pp3", "C.xmp");
        expect(items).toHaveLength(1);
        expect(ignored.map(i => i.name).sort()).toEqual(["B.ARW.pp3", "C.xmp"]);
    });

    test("re-encoded stills, hidden and unknown files are ignored", () => {
        const { items, ignored } = pair("c_moz_q85.jpg", "d_lossy.png", ".hidden.jpg", ".x_lossy.jxl", "notes.txt");
        expect(items).toEqual([]);
        expect(ignored).toHaveLength(5);
    });

    test("JXL outputs are archived items", () => {
        const { items, ignored } = pair("a_lossy_d1.0.jxl", "b_lossless.jxl", "x.jxl");
        expect(items.map(i => [i.id, i.kind])).toEqual([
            ["a_lossy_d1.0.jxl", "archived"], ["b_lossless.jxl", "archived"], ["x.jxl", "archived"],
        ]);
        expect(items[0]!.originals).toEqual([]);
        expect(ignored).toEqual([]);
    });

    test("archived JXL pairs with the RAW and its sidecars left in the folder", () => {
        const { items } = pair("DSC00164_lossy_d1.0.jxl", "DSC00164.ARW", "DSC00164.ARW.pp3", "DSC00164.xmp");
        expect(items).toHaveLength(1);
        const item = items[0]!;
        expect(item.kind).toBe("archived");
        expect(item.raw?.name).toBe("DSC00164.ARW");
        expect(item.rawSidecars.map(s => s.name)).toEqual(["DSC00164.ARW.pp3", "DSC00164.xmp"]);
    });

    test("JPG next to its JXL is one item: JXL primary, JPG and its sidecar ride along", () => {
        const { items } = pair("DSC1.JPG", "DSC1.JPG.xmp", "DSC1_lossy_d1.0.jxl", "DSC1.ARW");
        expect(items).toHaveLength(1);
        const item = items[0]!;
        expect(item.id).toBe("DSC1_lossy_d1.0.jxl");
        expect(item.kind).toBe("archived");
        expect(item.originals.map(f => f.name)).toEqual(["DSC1.JPG"]);
        expect(item.primarySidecars.map(f => f.name)).toEqual(["DSC1.JPG.xmp"]);
        expect(item.raw?.name).toBe("DSC1.ARW");
    });

    test("lossy and lossless archives of one shot are two items, the RAW goes to the first", () => {
        const { items } = pair("A_lossless.jxl", "A_lossy_d1.0.jxl", "A.ARW");
        expect(items.map(i => [i.id, i.raw?.name ?? null])).toEqual([["A_lossless.jxl", "A.ARW"], ["A_lossy_d1.0.jxl", null]]);
    });

    test("Pixel RAW+JPEG archive keeps its DNG", () => {
        const { items } = pair("PXL_20260101_123456789.RAW-01.MP.COVER_lossy_d1.0.jxl", "PXL_20260101_123456789.RAW-02.ORIGINAL.dng");
        expect(items).toHaveLength(1);
        expect(items[0]!.raw?.ext).toBe("dng");
    });

    test("extracted motion video next to a JXL is a live candidate", () => {
        const { items, liveCandidates } = pair("IMG_1_lossy_d1.0.jxl", "IMG_1_lossy_d1.0.mp4");
        expect(items.map(i => i.kind)).toEqual(["archived", "video"]);
        expect(liveCandidates.map(c => [c.itemId, c.video.name])).toEqual([["IMG_1_lossy_d1.0.jxl", "IMG_1_lossy_d1.0.mp4"]]);
    });

    test("unrelated video is its own item with no candidate", () => {
        const { items, liveCandidates } = pair("CLIP.MP4", "IMG_1.jpg");
        expect(items.find(i => i.kind === "video")?.id).toBe("CLIP.MP4");
        expect(liveCandidates).toEqual([]);
    });

    test("natural sort", () => {
        const { items } = pair("DSC10.JPG", "DSC2.JPG", "DSC1.JPG");
        expect(items.map(i => i.id)).toEqual(["DSC1.JPG", "DSC2.JPG", "DSC10.JPG"]);
    });
});
