import { describe, expect, test } from "bun:test";

import { autoDecision, judge } from "../src/bun/classify/rules.ts";
import { DEFAULT_SETTINGS, type AnalysisSummary } from "../src/shared/types.ts";

const t = DEFAULT_SETTINGS.thresholds;

function analysis(confidences: Record<string, number>): AnalysisSummary {
    return {
        model: "eye@v1.0.0", kind: "photo", confidences, scores: null, faces: [],
        sharpness: null, accelerator: "cpu", ms: 0,
    };
}

describe("judge", () => {
    test("sharp photo is not flagged", () => {
        expect(judge(analysis({ sharp: 1, blurry: 0, keeper: 0.8 }), null, t)).toEqual({ flag: false, reasons: [], hints: [] });
    });

    test("blurry at the recommended cutoff flags", () => {
        const j = judge(analysis({ blurry: 0.5 }), null, t);
        expect(j.flag).toBe(true);
        expect(j.reasons).toEqual([{ tag: "blurry", confidence: 0.5 }]);
    });

    test("test_or_duplicate_shot needs the higher bar", () => {
        expect(judge(analysis({ test_or_duplicate_shot: 0.6 }), null, t).flag).toBe(false);
        expect(judge(analysis({ test_or_duplicate_shot: 0.75 }), null, t).flag).toBe(true);
    });

    test("unreliable tags are hints only", () => {
        const j = judge(analysis({ forgettable: 0.9, eyes_closed: 0.7, bad_framing: 0.3 }), null, t);
        expect(j.flag).toBe(false);
        expect(j.hints).toEqual(["eyes_closed", "forgettable"]);
    });

    test("non-best stack members are flagged, the best is not", () => {
        expect(judge(analysis({}), { bestName: "A.JPG", isBest: false }, t).reasons).toEqual([{ tag: "duplicate", of: "A.JPG" }]);
        expect(judge(analysis({}), { bestName: "A.JPG", isBest: true }, t).flag).toBe(false);
        expect(judge(analysis({}), { bestName: "A.JPG", isBest: false }, { ...t, flagDuplicates: false }).flag).toBe(false);
    });

    test("no analysis (video, not yet analysed) is never flagged", () => {
        expect(judge(null, null, t).flag).toBe(false);
    });
});

describe("autoDecision", () => {
    const flagged = { flag: true, reasons: [{ tag: "blurry", confidence: 0.9 }], hints: [] };

    test("manual decisions survive reclassification", () => {
        const manual = { verdict: "keep" as const, source: "manual" as const, keepRaw: true };
        expect(autoDecision(manual, flagged)).toBe(manual);
    });

    test("auto decisions follow the judgement and keep keepRaw", () => {
        expect(autoDecision({ verdict: "keep", source: "auto", keepRaw: true }, flagged))
            .toEqual({ verdict: "delete", source: "auto", keepRaw: true });
        expect(autoDecision(undefined, { flag: false, reasons: [], hints: [] }))
            .toEqual({ verdict: "keep", source: "auto", keepRaw: false });
    });
});
