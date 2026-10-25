// View state and the RPC bridge to the Bun process (through the Electron main process; see
// src/electron/preload.ts).
//
// Items and analyses are large (thousands of entries) and change wholesale, so they live in
// shallowRefs that are replaced, not deeply reactive objects that Vue would have to proxy
// entry by entry. Decisions change one at a time from the keyboard, so they are a reactive
// record: toggling one tile re-renders only that tile.

import { computed, reactive, ref, shallowRef } from "vue";

import type { Bridge, EyeInfo, FolderState, InitInfo, MessageHandlers, RequestFunctions } from "../shared/rpc.ts";
import type { AnalysisSummary, ConvertResult, Decision, Item, Judgement, Settings, Stack } from "../shared/types.ts";

export const init = shallowRef<InitInfo | null>(null);
export const settings = shallowRef<Settings | null>(null);
export const folder = ref("");
export const items = shallowRef<Item[]>([]);
export const ignored = ref(0);
export const analyses = shallowRef<Record<string, AnalysisSummary>>({});
export const judgements = shallowRef<Record<string, Judgement>>({});
export const stacks = shallowRef<Stack[]>([]);
export const decisions = reactive<Record<string, Decision>>({});
export const eye = shallowRef<EyeInfo | null>(null);
export const applyProgress = shallowRef<{ done: number; total: number } | null>(null);
export const convertProgress = shallowRef<{ results: ConvertResult[]; done: number; total: number } | null>(null);
/** Encoding progress (0-99) of video proxies, by item id. */
export const videoProgress = reactive<Record<string, number>>({});
/** True while a folder is being scanned; the view shows a localised notice. */
export const busy = ref(false);
export const error = ref<string | null>(null);

/** item id -> its stack (for members and the keeper) */
export const stackOf = computed(() => {
    const map = new Map<string, Stack>();
    for (const s of stacks.value) for (const id of s.members) map.set(id, s);
    return map;
});

const messages: MessageHandlers = {
    eye: info => { eye.value = info; },
    analyses: batch => { analyses.value = { ...analyses.value, ...batch }; },
    judged: ({ judgements: j, stacks: s, decisions: d }) => {
        judgements.value = j;
        stacks.value = s;
        Object.assign(decisions, d);
    },
    items: changed => {
        const byId = new Map(changed.map(i => [i.id, i]));
        items.value = items.value.map(i => byId.get(i.id) ?? i);
    },
    applyProgress: p => { applyProgress.value = p; },
    convertProgress: ({ result, done, total }) => {
        const prev = convertProgress.value?.results ?? [];
        convertProgress.value = { results: [...prev, result], done, total };
    },
    videoProgress: ({ id, pct }) => { videoProgress[id] = pct; },
};

const bridge = (window as unknown as { cataglyph: Bridge }).cataglyph;
bridge.onMessage((name, payload) => (messages[name as keyof MessageHandlers] as ((p: unknown) => void) | undefined)?.(payload));

/** `rpc.openFolder({ folder })`: a request to the Bun process. Errors arrive as their message. */
export const rpc = new Proxy({} as RequestFunctions, {
    get: (_target, method: string) => async (params: unknown) => {
        const outcome = await bridge.request(method, params);
        if ("error" in outcome) throw new Error(outcome.error);
        return outcome.result;
    },
});

export async function boot() {
    const info = await rpc.init({});
    init.value = info;
    settings.value = info.settings;
}

export function mediaUrl(kind: "thumb" | "preview" | "original" | "video", item: Item): string {
    const i = init.value!;
    return `${i.mediaBase}/${kind}?t=${i.mediaToken}&id=${encodeURIComponent(item.id)}&k=${encodeURIComponent(item.contentKey)}`;
}

function applyState(state: FolderState) {
    folder.value = state.folder;
    items.value = state.items;
    ignored.value = state.ignored;
    analyses.value = state.analyses;
    judgements.value = state.judgements;
    stacks.value = state.stacks;
    for (const key of Object.keys(decisions)) delete decisions[key];
    Object.assign(decisions, state.decisions);
}

export async function openFolder(path: string) {
    busy.value = true;
    error.value = null;
    try {
        applyState(await rpc.openFolder({ folder: path }));
        settings.value = { ...settings.value!, recentFolders: [path, ...settings.value!.recentFolders.filter(f => f !== path)].slice(0, 8) };
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        busy.value = false;
    }
}

/**
 * Back to the start screen. A running analysis is stopped first: it belongs to this folder,
 * and its progress messages would otherwise keep arriving for a folder no longer shown.
 * (Decisions and analyses are already persisted; reopening the folder resumes.)
 */
export async function closeFolder() {
    if (eye.value?.state === "running" || eye.value?.state === "starting") await rpc.stopAnalysis({});
    folder.value = "";
    items.value = [];
    ignored.value = 0;
    analyses.value = {};
    judgements.value = {};
    stacks.value = [];
    eye.value = null;
    for (const key of Object.keys(decisions)) delete decisions[key];
}

export async function setDecision(ids: string[], change: Partial<Pick<Decision, "verdict" | "keepRaw">>) {
    const changes: Record<string, typeof change> = {};
    for (const id of ids) changes[id] = change;
    Object.assign(decisions, await rpc.setDecisions({ changes }));
}

export async function resetDecision(ids: string[]) {
    Object.assign(decisions, await rpc.resetDecisions({ ids }));
}

export async function saveSettings(next: Settings) {
    settings.value = await rpc.saveSettings({ settings: next });
}
