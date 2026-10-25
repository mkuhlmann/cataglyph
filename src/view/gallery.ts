// What the grid shows: filtering, stack collapsing, selection and keyboard actions.

import { computed, reactive, ref, watch } from "vue";

import type { Item } from "../shared/types.ts";
import { decisions, folder, items, judgements, mediaUrl, resetDecision, setDecision, stackOf } from "./state.ts";

export type Filter = "all" | "delete" | "keep" | "stacks" | "hints" | "raw" | "video";

export const filter = ref<Filter>("all");
export const tileSize = ref(220);
export const expanded = reactive(new Set<string>());
export const selected = ref<string | null>(null);
export const loupe = ref<string | null>(null);
/**
 * Detail view only: ←/→ step through the members of the current stack instead of the
 * gallery. Entered with ↓ on a stacked photo, left with ↑ (or by closing the detail view).
 */
export const inStack = ref(false);

export interface Entry {
    item: Item;
    /** Number of stack members, set on the keeper tile of a stack. */
    stackSize: number;
    /** Member shown because its stack is expanded (not the keeper). */
    inStack: boolean;
    stackId: string | null;
}

function matches(item: Item, f: Filter): boolean {
    const d = decisions[item.id];
    switch (f) {
        case "all": return true;
        case "delete": return d?.verdict === "delete";
        case "keep": return d?.verdict !== "delete";
        case "stacks": return stackOf.value.has(item.id);
        case "hints": return (judgements.value[item.id]?.hints.length ?? 0) > 0;
        case "raw": return item.raw !== null;
        case "video": return item.kind === "video";
    }
}

// Items are already sorted by name, which for camera files is shot order. A stack is shown
// where its keeper sits; collapsed, its other members are hidden, expanded they follow the
// keeper directly so the whole burst can be compared side by side.
export const entries = computed<Entry[]>(() => {
    const out: Entry[] = [];
    const byId = new Map(items.value.map(i => [i.id, i]));
    const stacks = stackOf.value;
    for (const item of items.value) {
        const stack = stacks.get(item.id);
        if (stack && stack.best !== item.id) continue;
        if (!stack) {
            if (matches(item, filter.value)) out.push({ item, stackSize: 0, inStack: false, stackId: null });
            continue;
        }
        const members = stack.members.map(id => byId.get(id)).filter((m): m is Item => !!m);
        if (!members.some(m => matches(m, filter.value))) continue;
        out.push({ item, stackSize: members.length, inStack: false, stackId: stack.id });
        if (expanded.has(stack.id)) {
            for (const m of members.slice(1)) out.push({ item: m, stackSize: 0, inStack: true, stackId: stack.id });
        }
    }
    return out;
});

export const counts = computed(() => {
    let del = 0;
    let keep = 0;
    let rawKept = 0;
    let bytes = 0;
    for (const item of items.value) {
        const d = decisions[item.id];
        if (d?.verdict === "delete") {
            del++;
            bytes += item.primary.size + item.originals.reduce((n, f) => n + f.size, 0) + (item.raw?.size ?? 0) + (item.motion?.size ?? 0);
        } else {
            keep++;
            if (item.raw && d?.keepRaw) rawKept++;
            else if (item.raw) bytes += item.raw.size;
        }
    }
    return { del, keep, rawKept, bytes };
});

/**
 * Position of an item in the grid. A member of a collapsed stack (opened from the detail
 * view's filmstrip) has no tile of its own and counts as the stack's tile; returning -1 for
 * it made the next arrow key jump back to the first photo of the folder.
 */
export function indexOf(id: string | null, list: Entry[] = entries.value): number {
    if (!id) return -1;
    const i = list.findIndex(e => e.item.id === id);
    if (i >= 0) return i;
    const stack = stackOf.value.get(id);
    return stack ? list.findIndex(e => e.stackId === stack.id) : -1;
}

function show(id: string) {
    selected.value = id;
    if (loupe.value) loupe.value = id;
}

export function move(delta: number) {
    const list = entries.value;
    if (!list.length) return;
    const i = indexOf(selected.value, list);
    const next = Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + delta));
    show(list[next]!.item.id);
}

function moveInStack(delta: number) {
    const stack = selected.value ? stackOf.value.get(selected.value) : undefined;
    if (!stack) return void (inStack.value = false);
    const i = Math.max(0, stack.members.indexOf(selected.value!));
    const next = stack.members[Math.max(0, Math.min(stack.members.length - 1, i + delta))];
    if (next) show(next);
}

/** The item the next →/← lands on, for preloading its preview. */
export function neighbour(delta: number): Item | null {
    const id = selected.value;
    if (!id) return null;
    if (inStack.value) {
        const members = stackOf.value.get(id)?.members ?? [];
        const next = members[members.indexOf(id) + delta];
        return next ? items.value.find(i => i.id === next) ?? null : null;
    }
    const list = entries.value;
    const i = indexOf(id, list);
    return i < 0 ? null : list[i + delta]?.item ?? null;
}

/** The selected item, or for a collapsed stack keeper: just the keeper. */
function targets(): string[] {
    return selected.value ? [selected.value] : [];
}

export async function handleKey(e: KeyboardEvent, cols: number) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const ids = targets();
    const stepper = loupe.value && inStack.value ? moveInStack : move;
    switch (e.key) {
        case "ArrowRight": stepper(1); break;
        case "ArrowLeft": stepper(-1); break;
        // Detail view: ↓ enters the current stack (←/→ then walk its members), ↑ goes back to
        // walking the gallery. In the grid they move by a row.
        case "ArrowDown":
            if (!loupe.value) move(cols);
            else if (selected.value && stackOf.value.has(selected.value)) inStack.value = true;
            break;
        case "ArrowUp":
            if (!loupe.value) move(-cols);
            else inStack.value = false;
            break;
        case "Home": move(-1e9); break;
        case "End": move(1e9); break;
        case "c": case "C": await setDecision(ids, { verdict: "keep" }); break;
        case "x": case "X": case "Delete": await setDecision(ids, { verdict: "delete" }); break;
        case "r": case "R":
            for (const id of ids) await setDecision([id], { keepRaw: !decisions[id]?.keepRaw });
            break;
        case "u": case "U": await resetDecision(ids); break;
        case " ":
            for (const id of ids) await setDecision([id], { verdict: decisions[id]?.verdict === "delete" ? "keep" : "delete" });
            break;
        case "s": case "S": {
            const stack = selected.value ? stackOf.value.get(selected.value) : undefined;
            if (stack) expanded.has(stack.id) ? expanded.delete(stack.id) : expanded.add(stack.id);
            break;
        }
        case "Enter": loupe.value = loupe.value ? null : selected.value; break;
        case "Escape":
            if (inStack.value) inStack.value = false;
            else loupe.value = null;
            break;
        default: return;
    }
    e.preventDefault();
}

// Selection, detail view and expanded stacks belong to the folder they were made in.
watch(folder, () => {
    selected.value = null;
    loupe.value = null;
    expanded.clear();
});

// Leaving the detail view, or landing outside any stack, ends stack navigation.
watch([loupe, selected], ([l, id]) => {
    if (!l || !id || !stackOf.value.has(id)) inStack.value = false;
});

// Preloading: previews are rendered on demand by the media server (a 2560 px WebP from a
// 60 MP JPEG takes a few hundred ms) and then cached by the browser (immutable URLs), so
// asking for the neighbours ahead of time makes ←/→ in the detail view instant. Decoding
// them too means the switch doesn't even wait for the WebP decode.
const warm = new Map<string, HTMLImageElement>();
const WARM_LIMIT = 12;

function preload(item: Item | null) {
    if (!item) return;
    const url = mediaUrl("preview", item);
    if (warm.has(url)) return;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    img.decode().catch(() => {});
    warm.set(url, img);
    // Holding the Image keeps its decoded bitmap in memory; drop the oldest beyond a few.
    while (warm.size > WARM_LIMIT) warm.delete(warm.keys().next().value!);
}

/**
 * Warm the previews around the selection. The media server's queue is LIFO (the grid
 * wants what scrolled into view last), so request the less likely one first: the next
 * photo then renders before the previous one.
 */
export function preloadNeighbours() {
    preload(neighbour(-1));
    preload(neighbour(1));
}

// In the grid, warm only the selected photo's preview (Enter opens it), and only once
// the selection rests, so holding an arrow key doesn't queue a render per tile passed.
let idle: ReturnType<typeof setTimeout> | undefined;
watch(selected, id => {
    clearTimeout(idle);
    if (!id || loupe.value) return;
    idle = setTimeout(() => preload(items.value.find(i => i.id === id) ?? null), 250);
});
