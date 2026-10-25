// Condenses an Eye `Analysis` into the JSON the UI and the rules work with.
//
// The full analysis (as `JSON.stringify(analysis)`) is stored too, because Eye.duplicates
// and Eye.best need the restored `Analysis` objects with their embeddings. The summary is
// what crosses the RPC boundary: 611 tags and a 512-float embedding per photo would turn a
// 1000-photo folder into ~10 MB of JSON for the view, almost all of it scene scores nobody
// looks at.

import type { AnalysisSummary } from "../../shared/types.ts";

// Every tag that is not one of the 558 Open Images scenes. These are always kept; scenes are
// cut down to the few strongest. Lists from the Eye docs (photo type, keep/delete, quality,
// people, faces, sensitive).
export const NON_SCENE_TAGS: ReadonlySet<string> = new Set([
    "photo", "selfie", "screenshot", "photo_of_screen", "receipt", "document", "id_card",
    "whiteboard", "map", "chart_or_slide", "meme_or_graphic", "illustration_or_art",
    "shopping_reference", "medical_reference", "repair_reference", "other", "reference",
    "keeper", "forgettable", "accidental", "technical_flaw", "unusable", "bad_framing",
    "bad_lighting", "test_or_duplicate_shot", "reference_photo", "low_content",
    "sharp", "blurry", "bokeh", "peak_moment", "rotated",
    "people", "group_shot", "portrait", "smiling", "eyes_closed", "everyone_smiling",
    "everyone_looking", "candid", "looking_at_camera", "looking_away", "happy", "surprised",
    "sensitive", "nsfw_explicit", "nsfw_suggestive", "blood_injury", "medical_hospital",
    "funeral", "accident_disaster", "violence_protest", "weapon",
]);

const TOP_SCENES = 8;
const MIN_SCENE = 0.3;

// The subset of the SDK's Analysis this module reads. Declared structurally so the summary
// can be computed from a live analysis or from one restored with Analysis.fromJSON.
interface AnalysisLike {
    model: string;
    kind: string | null;
    confidences: Record<string, number>;
    scores: { aesthetic: number; keeper: number; cover: number } | null;
    faces: { box: { x0: number; y0: number; x1: number; y1: number }; confidences: Record<string, number>; quality: number }[] | null;
    details: {
        sharpness: { score: number; blurMap: { width: number; height: number; values: ArrayLike<number> } } | null;
    } | null;
}

export function summarize(analysis: AnalysisLike, accelerator: "gpu" | "cpu", ms: number): AnalysisSummary {
    const confidences: Record<string, number> = {};
    const scenes: [string, number][] = [];
    for (const [tag, value] of Object.entries(analysis.confidences)) {
        if (NON_SCENE_TAGS.has(tag)) confidences[tag] = round(value);
        else if (value >= MIN_SCENE) scenes.push([tag, value]);
    }
    scenes.sort((a, b) => b[1] - a[1]);
    for (const [tag, value] of scenes.slice(0, TOP_SCENES)) confidences[tag] = round(value);

    const sharp = analysis.details?.sharpness ?? null;
    return {
        model: analysis.model,
        kind: analysis.kind,
        confidences,
        scores: analysis.scores
            ? { aesthetic: round(analysis.scores.aesthetic), keeper: round(analysis.scores.keeper), cover: round(analysis.scores.cover) }
            : null,
        faces: (analysis.faces ?? []).map(face => ({
            box: face.box,
            confidences: Object.fromEntries(Object.entries(face.confidences).map(([k, v]) => [k, round(v)])),
            quality: round(face.quality),
        })),
        sharpness: sharp
            ? {
                score: round(sharp.score),
                blurMap: {
                    width: sharp.blurMap.width,
                    height: sharp.blurMap.height,
                    values: Array.from(sharp.blurMap.values, v => round(v)),
                },
            }
            : null,
        accelerator,
        ms: Math.round(ms),
    };
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}
