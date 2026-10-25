import { describe, expect, test } from "bun:test";

// Catalogs only: i18n/index.ts imports the view state (Vue refs), which has no place in a
// unit test.
import { de } from "../src/view/i18n/de.ts";
import { en } from "../src/view/i18n/en.ts";

const enMap: Record<string, string> = en;
const deMap: Record<string, string> = de;

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort();

describe("i18n catalogs", () => {
    test("de has every en key and vice versa", () => {
        const e = Object.keys(enMap).sort();
        const d = Object.keys(deMap).sort();
        expect(d.filter(k => !(k in enMap))).toEqual([]);
        expect(e.filter(k => !(k in deMap))).toEqual([]);
    });

    test("no empty strings", () => {
        for (const [name, map] of [["en", enMap], ["de", deMap]] as const) {
            for (const [k, v] of Object.entries(map)) expect(v.trim(), `${name}:${k}`).not.toBe("");
        }
    });

    test("placeholders match per key", () => {
        for (const [k, v] of Object.entries(enMap)) {
            expect(placeholders(deMap[k] ?? ""), k).toEqual(placeholders(v));
        }
    });
});
