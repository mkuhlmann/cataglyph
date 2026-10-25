// Turns Eye's tag confidences into "flag for deletion" suggestions.
//
// The split between reasons (flag) and hints (badge only) follows how reliable each tag is.
// Eye's own docs call the keep/delete reasons like `forgettable` and `bad_framing` the least
// reliable tags, so those never flag on their own - they show as hints and the user decides.
// Technical failures (`blurry`, `unusable`, `accidental`, `technical_flaw`) are what the model
// is good at and what nobody wants in an archive, so those flag at the recommended 0.5.
// `test_or_duplicate_shot` gets a higher bar because a real near-duplicate is already handled
// by the stack logic, and a false positive there removes a unique photo.

import type { AnalysisSummary, Decision, Judgement, Reason, Thresholds } from "../../shared/types.ts";

// Tags that flag the item, each checked against its own threshold in Thresholds.
const FLAG_TAGS = ["blurry", "unusable", "accidental", "technical_flaw", "test_or_duplicate_shot"] as const;

// Worth a second look, never flagged automatically.
const HINT_TAGS = [
    "eyes_closed", "bad_framing", "bad_lighting", "forgettable", "low_content",
    "screenshot", "receipt", "document", "photo_of_screen", "rotated",
] as const;

export interface StackRole {
    /** Displayed name of the stack's keeper, for the reason text. */
    bestName: string;
    isBest: boolean;
}

export function judge(analysis: AnalysisSummary | null, stack: StackRole | null, t: Thresholds): Judgement {
    const reasons: Reason[] = [];
    const hints: string[] = [];

    if (stack && !stack.isBest && t.flagDuplicates) {
        reasons.push({ tag: "duplicate", of: stack.bestName });
    }

    if (analysis) {
        const c = analysis.confidences;
        for (const tag of FLAG_TAGS) {
            const value = c[tag];
            if (value !== undefined && value >= t[tag]) reasons.push({ tag, confidence: value });
        }
        for (const tag of HINT_TAGS) {
            const value = c[tag];
            if (value !== undefined && value >= t.hint) hints.push(tag);
        }
    }

    return { flag: reasons.length > 0, reasons, hints };
}

/**
 * The decision an item should have after (re)classification. A manual decision is the
 * user's and is returned unchanged; an auto one follows the judgement. keepRaw is never
 * touched here - it is only ever set by the user.
 */
export function autoDecision(current: Decision | undefined, judgement: Judgement): Decision {
    if (current?.source === "manual") return current;
    return {
        verdict: judgement.flag ? "delete" : "keep",
        source: "auto",
        keepRaw: current?.keepRaw ?? false,
    };
}
