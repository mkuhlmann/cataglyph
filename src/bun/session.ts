// One opened folder: its items, the user's decisions, Eye's analyses and what follows from
// them. The RPC handlers in index.ts are thin wrappers around this class.

import { stat } from "node:fs/promises";
import { relative } from "node:path";

import type { ApplyPreview, ConvertPreview, EyeInfo, FolderState } from "../shared/rpc.ts";
import type {
    AnalysisSummary, ApplySummary, ConvertResult, ConvertSettings, ConvertSummary, Decision, Item,
    Judgement, Settings, Stack,
} from "../shared/types.ts";
import { executeApply } from "./apply/apply.ts";
import { planApply, summarizePlan } from "./apply/plan.ts";
import type { EyeClient } from "./classify/eye-client.ts";
import { autoDecision, judge, type StackRole } from "./classify/rules.ts";
import { runConvert, type ConvertJob } from "./convert/jxl.ts";
import type { MediaServer } from "./media/server.ts";
import { displaySource, sourceSize } from "./media/thumbs.ts";
import { readBasics } from "./meta/metadata.ts";
import { contentKeyOf } from "./scan/pairing.ts";
import { scanFolder } from "./scan/scan.ts";
import type { Store } from "./store/db.ts";

/** Analyses are cached per model; bump with the weights in models/. */
export const EYE_MODEL = "eye@v1.0.0";

const CONVERTIBLE = new Set(["jpg", "jpeg", "png", "heic", "heif"]);

export interface Pusher {
    eye(info: EyeInfo): void;
    analyses(batch: Record<string, AnalysisSummary>): void;
    judged(payload: { judgements: Record<string, Judgement>; stacks: Stack[]; decisions: Record<string, Decision> }): void;
    items(items: Item[]): void;
    applyProgress(p: { done: number; total: number }): void;
    convertProgress(p: { result: ConvertResult; done: number; total: number }): void;
}

export class Session {
    folder = "";
    items: Item[] = [];
    private byId = new Map<string, Item>();
    private ignored = 0;
    decisions: Record<string, Decision> = {};
    analyses: Record<string, AnalysisSummary> = {};
    private analysisJson = new Map<string, string>();
    judgements: Record<string, Judgement> = {};
    stacks: Stack[] = [];
    private generation = 0;

    private eyeInfo: EyeInfo = { state: "idle", accelerator: null, adapter: null, done: 0, total: 0, meanMs: 0 };
    private stopRequested = false;
    private convertAbort: AbortController | null = null;

    constructor(
        private store: Store,
        private eye: EyeClient,
        private media: MediaServer,
        private push: Pusher,
        private settings: () => Settings,
    ) {}

    // ------------------------------------------------------------------------
    // OPEN
    // ------------------------------------------------------------------------

    async open(folder: string): Promise<FolderState> {
        const generation = ++this.generation;
        this.stopRequested = true;
        const { items, ignored } = await scanFolder(folder);
        this.folder = folder;
        this.items = items;
        this.byId = new Map(items.map(i => [i.id, i]));
        this.ignored = ignored.length;
        this.media.setItems(items);

        // Cached basics and analyses are applied synchronously; whatever is missing is read
        // in the background so the gallery appears at once, even for 2000 photos.
        const missingBasics: Item[] = [];
        this.analyses = {};
        this.analysisJson.clear();
        for (const item of items) {
            const basics = this.store.getBasics(item.contentKey);
            if (basics) Object.assign(item, basics);
            else missingBasics.push(item);
            const cached = this.store.getAnalysis(item.contentKey, EYE_MODEL);
            if (cached) {
                this.analyses[item.id] = cached.summary;
                this.analysisJson.set(item.id, cached.json);
            }
        }

        // Decisions of items that are gone (deleted, or converted to a .jxl under a new id) are
        // dropped here as well as in the store, or they lingered in the view's state.
        const stored = this.store.getDecisions(folder);
        this.decisions = Object.fromEntries(Object.entries(stored).filter(([id]) => this.byId.has(id)));
        this.store.pruneDecisions(folder, items.map(i => i.id));
        this.stacks = [];
        this.rejudge();

        this.eyeInfo = {
            state: "idle", accelerator: this.eye.status?.accelerator ?? null, adapter: this.eye.status?.adapter ?? null,
            done: Object.keys(this.analyses).length, total: this.analysable().length, meanMs: 0,
        };
        void this.fillBasics(missingBasics, generation).then(() => {
            // Grouping needs capture times; with everything cached it can run right away.
            if (generation === this.generation && this.analysisJson.size > 1) void this.regroup(generation);
        });

        return this.state();
    }

    state(): FolderState {
        return {
            folder: this.folder,
            items: this.items,
            ignored: this.ignored,
            decisions: this.decisions,
            analyses: this.analyses,
            judgements: this.judgements,
            stacks: this.stacks,
        };
    }

    private async fillBasics(items: Item[], generation: number) {
        let batch: Item[] = [];
        const flush = () => {
            if (batch.length && generation === this.generation) this.push.items(batch);
            batch = [];
        };
        let next = 0;
        const worker = async () => {
            while (next < items.length && generation === this.generation) {
                const item = items[next++]!;
                try {
                    const b = await readBasics(item.primary.path);
                    if (!b.width || !b.height) Object.assign(b, await sourceSize(item).catch(() => ({ width: 0, height: 0 })));
                    Object.assign(item, b);
                    this.store.putBasics(item.contentKey, b);
                } catch (err) {
                    console.warn(`[basics] ${item.id}: ${(err as Error).message}`);
                }
                batch.push(item);
                if (batch.length >= 50) flush();
            }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        flush();
    }

    // ------------------------------------------------------------------------
    // ANALYSIS
    // ------------------------------------------------------------------------

    private analysable(): Item[] {
        return this.items.filter(i => i.kind !== "video");
    }

    eyeStatus(): EyeInfo {
        return this.eyeInfo;
    }

    private setEye(patch: Partial<EyeInfo>) {
        this.eyeInfo = { ...this.eyeInfo, ...patch };
        this.push.eye(this.eyeInfo);
    }

    async startAnalysis(): Promise<EyeInfo> {
        if (this.eyeInfo.state === "running" || this.eyeInfo.state === "starting") return this.eyeInfo;
        const generation = this.generation;
        const todo = this.analysable().filter(i => !this.analyses[i.id]);
        const total = this.analysable().length;
        this.stopRequested = false;

        if (!this.eye.running) {
            this.setEye({ state: "starting", message: undefined });
            try {
                const status = await this.eye.start(this.settings().useGpu);
                this.setEye({ accelerator: status.accelerator, adapter: status.adapter });
            } catch (err) {
                this.setEye({ state: "error", message: (err as Error).message });
                return this.eyeInfo;
            }
        }
        this.setEye({ state: "running", done: total - todo.length, total, meanMs: 0 });
        void this.analyzeLoop(todo, generation);
        return this.eyeInfo;
    }

    stopAnalysis(): EyeInfo {
        this.stopRequested = true;
        return this.eyeInfo;
    }

    private async analyzeLoop(todo: Item[], generation: number) {
        let pending: Record<string, AnalysisSummary> = {};
        let lastFlush = performance.now();
        let sinceGroup = 0;
        let msTotal = 0;
        let msCount = 0;
        const flush = () => {
            if (Object.keys(pending).length) this.push.analyses(pending);
            pending = {};
            lastFlush = performance.now();
            this.setEye({ adapter: this.eye.status?.adapter ?? this.eyeInfo.adapter });
        };

        const one = async (item: Item, retry = true): Promise<void> => {
            try {
                const src = await displaySource(item);
                const { summary, json } = await this.eye.analyze(src);
                if (generation !== this.generation) return;
                this.store.putAnalysis(item.contentKey, EYE_MODEL, summary, json);
                this.analyses[item.id] = summary;
                this.analysisJson.set(item.id, json);
                pending[item.id] = summary;
                msTotal += summary.ms;
                msCount++;
                sinceGroup++;
            } catch (err) {
                // A crashed Eye process rejects everything in flight. Restart it once (on the
                // CPU if the GPU path was the one that died) and retry this photo.
                if (!this.eye.running && retry) {
                    try {
                        const status = await this.eye.start(false);
                        this.setEye({ accelerator: status.accelerator, adapter: null, fellBackToCpu: true });
                        return one(item, false);
                    } catch {
                        // fall through to the per-item error
                    }
                }
                console.warn(`[eye] ${item.id}: ${(err as Error).message}`);
            }
        };

        // Two in flight: the Eye process decodes the next photo while the current one is on
        // the GPU, and nothing more queues up than that (decodes are 1536 px RGB buffers).
        let next = 0;
        const worker = async () => {
            while (next < todo.length && !this.stopRequested && generation === this.generation) {
                await one(todo[next++]!);
                this.eyeInfo.done++;
                this.eyeInfo.meanMs = msCount ? Math.round(msTotal / msCount) : 0;
                if (performance.now() - lastFlush > 300) flush();
                if (sinceGroup >= 150) {
                    sinceGroup = 0;
                    await this.regroup(generation);
                }
            }
        };
        await Promise.all([worker(), worker()]);
        if (generation !== this.generation) return;
        flush();
        this.setEye({ state: this.stopRequested ? "idle" : "done", adapter: this.eye.status?.adapter ?? this.eyeInfo.adapter });
        await this.regroup(generation);
    }

    private async regroup(generation: number) {
        const ids = [...this.analysisJson.keys()].filter(id => this.byId.has(id));
        if (ids.length < 2 || !this.eye.running) {
            this.publishJudgements();
            return;
        }
        try {
            const { groups, best } = await this.eye.group(
                ids.map(id => this.analysisJson.get(id)!),
                ids.map(id => this.byId.get(id)?.captureTime ?? null),
            );
            if (generation !== this.generation) return;
            this.stacks = groups.map((group, g) => {
                const bestId = ids[best[g] ?? group[0]!]!;
                const members = [bestId, ...group.map(i => ids[i]!).filter(id => id !== bestId)];
                return { id: bestId, members, best: bestId };
            });
        } catch (err) {
            console.warn(`[eye] grouping failed: ${(err as Error).message}`);
        }
        this.publishJudgements();
    }

    private publishJudgements() {
        this.rejudge();
        this.store.putDecisions(this.folder, this.decisions);
        this.push.judged({ judgements: this.judgements, stacks: this.stacks, decisions: this.decisions });
    }

    /** Recomputes every judgement and the auto decisions that follow from them. */
    rejudge() {
        const roles = new Map<string, StackRole>();
        for (const stack of this.stacks) {
            const bestName = this.byId.get(stack.best)?.primary.name ?? stack.best;
            for (const id of stack.members) roles.set(id, { bestName, isBest: id === stack.best });
        }
        const t = this.settings().thresholds;
        for (const item of this.items) {
            const j = judge(this.analyses[item.id] ?? null, roles.get(item.id) ?? null, t);
            this.judgements[item.id] = j;
            this.decisions[item.id] = autoDecision(this.decisions[item.id], j);
        }
    }

    // ------------------------------------------------------------------------
    // DECISIONS
    // ------------------------------------------------------------------------

    setDecisions(changes: Record<string, Partial<Pick<Decision, "verdict" | "keepRaw">>>): Record<string, Decision> {
        const changed: Record<string, Decision> = {};
        for (const [id, change] of Object.entries(changes)) {
            const current = this.decisions[id] ?? { verdict: "keep", source: "auto", keepRaw: false };
            // keepRaw alone doesn't make the verdict manual: toggling "keep RAW" says nothing
            // about whether the classifier's keep/delete call was right.
            const next: Decision = {
                verdict: change.verdict ?? current.verdict,
                source: change.verdict !== undefined ? "manual" : current.source,
                keepRaw: change.keepRaw ?? current.keepRaw,
            };
            this.decisions[id] = next;
            changed[id] = next;
        }
        this.store.putDecisions(this.folder, changed);
        return changed;
    }

    resetDecisions(ids: string[]): Record<string, Decision> {
        const changed: Record<string, Decision> = {};
        for (const id of ids) {
            const current = this.decisions[id];
            const j = this.judgements[id];
            if (!current || !j) continue;
            changed[id] = autoDecision({ ...current, source: "auto" }, j);
            this.decisions[id] = changed[id];
        }
        this.store.putDecisions(this.folder, changed);
        return changed;
    }

    // ------------------------------------------------------------------------
    // STEP 4: APPLY
    // ------------------------------------------------------------------------

    previewApply(deleteMode: "trash" | "permanent"): ApplyPreview {
        const actions = planApply(this.items, this.decisions, { folder: this.folder, deleteMode });
        const sum = summarizePlan(actions);
        const withRaw = this.items.filter(i => i.raw && this.decisions[i.id]?.verdict === "keep");
        return {
            actions,
            trash: sum.trash,
            unlink: sum.unlink,
            move: sum.move,
            bytesFreed: sum.bytesFreed,
            itemsDeleted: this.items.filter(i => this.decisions[i.id]?.verdict === "delete").length,
            rawsKept: withRaw.filter(i => this.decisions[i.id]?.keepRaw).length,
            rawsDeleted: withRaw.filter(i => !this.decisions[i.id]?.keepRaw).length,
        };
    }

    async runApply(deleteMode: "trash" | "permanent"): Promise<ApplySummary> {
        this.stopRequested = true;
        const actions = planApply(this.items, this.decisions, { folder: this.folder, deleteMode });
        return await executeApply(actions, (done, total) => {
            if (done % 10 === 0 || done === total) this.push.applyProgress({ done, total });
        });
    }

    // ------------------------------------------------------------------------
    // STEP 5: CONVERT
    // ------------------------------------------------------------------------

    private convertJobs(): { jobs: ConvertJob[]; skipped: { id: string; ext: string }[] } {
        const jobs: ConvertJob[] = [];
        const skipped: { id: string; ext: string }[] = [];
        for (const item of this.items) {
            if (this.decisions[item.id]?.verdict === "delete") continue;
            // Archived items are already JPEG XL: left out silently rather than listed as
            // skipped, which would read like a problem.
            if (item.kind !== "photo") continue;
            if (!CONVERTIBLE.has(item.primary.ext)) {
                skipped.push({ id: item.id, ext: item.primary.ext });
                continue;
            }
            jobs.push({
                itemId: item.id,
                still: item.primary,
                motion: item.motion,
                embeddedMotion: item.embeddedMotion,
                hasGainMap: item.hasGainMap,
            });
        }
        return { jobs, skipped };
    }

    previewConvert(): ConvertPreview {
        const { jobs, skipped } = this.convertJobs();
        return {
            count: jobs.length,
            bytes: jobs.reduce((s, j) => s + j.still.size, 0),
            skipped,
            gainMaps: jobs.filter(j => j.hasGainMap).length,
            motion: jobs.filter(j => j.embeddedMotion || j.motion).length,
        };
    }

    async runConvert(settings: ConvertSettings): Promise<ConvertSummary> {
        this.stopRequested = true;
        const { jobs } = this.convertJobs();
        this.convertAbort = new AbortController();
        try {
            const summary = await runConvert(jobs, settings, (result, done, total) => {
                this.push.convertProgress({ result, done, total });
            }, this.convertAbort.signal);
            await this.carryOver(summary.results);
            return summary;
        } finally {
            this.convertAbort = null;
        }
    }

    /**
     * Hands each converted photo's analysis, basics and decision to the .jxl that replaced it.
     * Both are keyed by the primary file (analyses by content key, decisions by item id), so
     * after the rename Eye would otherwise analyse the whole folder again (a djxl decode plus
     * inference per photo) and manual decisions and keep-RAW choices would be lost. The pixels
     * are the same photo, so the old verdicts still apply. Runs before the view rescans.
     */
    private async carryOver(results: ConvertResult[]) {
        const decisions: Record<string, Decision> = {};
        for (const r of results) {
            const source = this.byId.get(r.itemId);
            if (r.status !== "ok" || !r.output || !source) continue;
            const output = await stat(r.output).catch(() => null);
            if (!output) continue;
            const id = relative(this.folder, r.output);
            const key = contentKeyOf(id, output);
            const analysis = this.store.getAnalysis(source.contentKey, EYE_MODEL);
            if (analysis) this.store.putAnalysis(key, EYE_MODEL, analysis.summary, analysis.json);
            const basics = this.store.getBasics(source.contentKey);
            if (basics) this.store.putBasics(key, basics);
            const decision = this.decisions[source.id];
            if (decision) decisions[id] = decision;
        }
        this.store.putDecisions(this.folder, decisions);
    }

    cancelConvert(): boolean {
        this.convertAbort?.abort();
        return this.convertAbort !== null;
    }

    item(id: string): Item | undefined {
        return this.byId.get(id);
    }
}
