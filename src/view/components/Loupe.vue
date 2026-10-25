<script setup lang="ts" vapor>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import type { Details } from "../../shared/rpc.ts";
import { inStack, loupe, move, neighbour, preloadNeighbours, selected } from "../gallery.ts";
import type { Reason } from "../../shared/types.ts";
import { formatBytes, formatNumber, locale, t, tagLabel } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/en.ts";
import { analyses, decisions, items, judgements, mediaUrl, resetDecision, rpc, setDecision, settings, stackOf, videoProgress } from "../state.ts";

const item = computed(() => items.value.find(i => i.id === loupe.value) ?? null);
const analysis = computed(() => (item.value ? analyses.value[item.value.id] : undefined));
const judgement = computed(() => (item.value ? judgements.value[item.value.id] : undefined));
const decision = computed(() => (item.value ? decisions[item.value.id] : undefined));
const stack = computed(() => (item.value ? stackOf.value.get(item.value.id) : undefined));
const details = shallowRef<Details | null>(null);

const zoom = ref(false);
const pan = ref({ x: 50, y: 50 });
const showFaces = ref(false);
const showBlur = ref(false);
const canvas = ref<HTMLCanvasElement | null>(null);
const imgEl = ref<HTMLImageElement | null>(null);
const imgBox = ref({ left: 0, top: 0, width: 0, height: 0 });

// Metadata of the photos around the current one is fetched ahead too (see onLoad), so the
// side panel fills in as fast as the preview.
const detailCache = new Map<string, Promise<Details>>();
function fetchDetails(id: string): Promise<Details> {
    let p = detailCache.get(id);
    if (!p) {
        p = rpc.details({ id });
        p.catch(() => detailCache.delete(id));
        detailCache.set(id, p);
        if (detailCache.size > 24) detailCache.delete(detailCache.keys().next().value!);
    }
    return p;
}

// Videos play in place. CEF can't decode H.264/HEVC, so the main process may first have to
// encode an AV1 proxy (a few seconds; progress shows over the poster frame).
const video = ref<{ id: string; state: "preparing" | "ready" | "failed" | "disabled"; error?: string } | null>(null);
watch(item, async it => {
    video.value = null;
    if (it?.kind !== "video") return;
    const id = it.id;
    video.value = { id, state: "preparing" };
    const res = await rpc.prepareVideo({ id });
    if (video.value?.id !== id) return;
    video.value = res.ok ? { id, state: "ready" } : { id, state: res.disabled ? "disabled" : "failed", error: res.error };
}, { immediate: true });

watch(item, async it => {
    details.value = null;
    zoom.value = false;
    if (!it) return;
    const id = it.id;
    const d = await fetchDetails(id);
    if (loupe.value === id) details.value = d;
}, { immediate: true });

function onLoad() {
    measure();
    preloadNeighbours();
    for (const n of [neighbour(1), neighbour(-1)]) if (n) void fetchDetails(n.id).catch(() => {});
}

// Tags sorted by confidence, scenes and quality alike; the rules' reasons are shown above.
const tags = computed(() =>
    Object.entries(analysis.value?.confidences ?? {})
        .filter(([, v]) => v >= 0.3)
        .sort((a, b) => b[1] - a[1]),
);

// The <img> is object-fit: contain, so overlays need the rectangle the image really occupies.
function measure() {
    const el = imgEl.value;
    if (!el || !el.naturalWidth) return;
    // object-fit works in the content box: without taking the padding (room for the
    // filmstrip) off, the blur map and face boxes came out larger than the photo and shifted.
    const cs = getComputedStyle(el);
    const [pl, pr, pt, pb] = [cs.paddingLeft, cs.paddingRight, cs.paddingTop, cs.paddingBottom].map(parseFloat) as [number, number, number, number];
    const cw = el.clientWidth - pl - pr;
    const ch = el.clientHeight - pt - pb;
    const scale = Math.min(cw / el.naturalWidth, ch / el.naturalHeight);
    const w = el.naturalWidth * scale;
    const h = el.naturalHeight * scale;
    imgBox.value = { left: el.offsetLeft + pl + (cw - w) / 2, top: el.offsetTop + pt + (ch - h) / 2, width: w, height: h };
    drawBlur();
}

function drawBlur() {
    const c = canvas.value;
    const map = analysis.value?.sharpness?.blurMap;
    if (!c || !map) return;
    c.width = map.width;
    c.height = map.height;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(map.width, map.height);
    const max = Math.max(...map.values, 1e-6);
    map.values.forEach((v, i) => {
        const a = Math.min(1, v / max);
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 60;
        img.data[i * 4 + 2] = 60;
        img.data[i * 4 + 3] = Math.round(a * 170);
    });
    ctx.putImageData(img, 0, 0);
}

watch([showBlur, analysis], () => requestAnimationFrame(drawBlur));

function onMouseMove(e: MouseEvent) {
    if (!zoom.value) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    pan.value = { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
}

function onKey(e: KeyboardEvent) {
    if (e.key === "z" || e.key === "Z") zoom.value = !zoom.value;
    else if (e.key === "f" || e.key === "F") showFaces.value = !showFaces.value;
    else if (e.key === "b" || e.key === "B") showBlur.value = !showBlur.value;
}

onMounted(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
});
onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", measure);
});

function close() {
    loupe.value = null;
}

function go(id: string) {
    selected.value = id;
    loupe.value = id;
}

function reasonText(r: Reason): string {
    if (r.tag === "duplicate") return t("reason.duplicate", { of: r.of ?? "" });
    return r.confidence === undefined ? tagLabel(r.tag) : `${tagLabel(r.tag)} ${formatNumber(r.confidence, 2)}`;
}

// "yyyy-MM-dd HH:mm:ss" is camera-local wall-clock time without an offset: build the Date
// from its parts so it is not shifted by a UTC parse.
function formatCaptured(value: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!m) return value;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
    return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(y, mo - 1, d, h, mi, s));
}

// exposureComp and rating are "0" when unset: noise, not information.
const rows = computed(() =>
    (details.value?.rows ?? [])
        .filter(([k, v]) => !((k === "exposureComp" || k === "rating") && v === "0"))
        .map(([k, v]) => [k === "captured" ? t("meta.captured") : metaLabel(k), k === "captured" ? formatCaptured(v) : v] as [string, string]),
);
function metaLabel(key: string): string {
    const k = `meta.${key}` as MessageKey;
    return t(k) === k ? key : t(k);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

// The verdict at a glance, along the top edge of the photo column: one bar for the image, and
// a second for the RAW when there is one, since the RAW goes unless "keep RAW" is set even
// when the image is kept.
const bars = computed(() => {
    const it = item.value;
    if (!it || settings.value?.verdictBar === false) return [];
    const keep = decision.value?.verdict !== "delete";
    const out = [{ label: it.primary.ext.toUpperCase(), name: it.primary.name, keep }];
    if (it.raw) out.push({ label: it.raw.ext.toUpperCase(), name: it.raw.name, keep: keep && !!decision.value?.keepRaw });
    return out;
});
</script>

<template>
    <div v-if="item" class="loupe">
        <div class="stage" :class="{ zoom, isVideo: item.kind === 'video' }" @mousemove="onMouseMove" @click="item.kind !== 'video' && (zoom = !zoom)">
            <template v-if="item.kind === 'video'">
                <!-- The player never keeps focus: the arrow keys and Space stay with the
                     gallery's shortcuts instead of seeking/pausing a focused <video>. -->
                <video
                    v-if="video?.state === 'ready'"
                    :key="item.id"
                    :src="mediaUrl('video', item)"
                    :poster="mediaUrl('preview', item)"
                    class="fit"
                    controls
                    autoplay
                    @loadedmetadata="preloadNeighbours()"
                    @focus="($event.target as HTMLElement).blur()"
                    @click.stop
                />
                <template v-else>
                    <img :src="mediaUrl('preview', item)" class="fit" draggable="false" @load="preloadNeighbours()" />
                    <div v-if="video" class="videoState">
                        <span v-if="video.state === 'preparing'">{{ t("loupe.videoPreparing", { pct: videoProgress[item.id] ?? 0 }) }}</span>
                        <span v-else-if="video.state === 'disabled'" class="muted">{{ t("loupe.videoNoTranscode") }}</span>
                        <span v-else class="bad">{{ t("loupe.videoFailed", { error: video.error ?? "" }) }}</span>
                    </div>
                </template>
            </template>
            <img
                v-else-if="!zoom"
                ref="imgEl"
                :src="mediaUrl('preview', item)"
                class="fit"
                draggable="false"
                @load="onLoad"
            />
            <img
                v-else
                :src="mediaUrl('original', item)"
                class="full"
                :style="{ objectPosition: `${pan.x}% ${pan.y}%` }"
                draggable="false"
            />
            <div v-if="bars.length" class="verdictBars">
                <div
                    v-for="b in bars"
                    :key="b.label"
                    class="bar"
                    :class="b.keep ? 'keep' : 'del'"
                    :title="t(b.keep ? 'loupe.bar.kept' : 'loupe.bar.deleted', { name: b.name })"
                />
            </div>
            <template v-if="!zoom">
                <canvas
                    v-show="showBlur && analysis?.sharpness"
                    ref="canvas"
                    class="overlay-map"
                    :style="{ left: imgBox.left + 'px', top: imgBox.top + 'px', width: imgBox.width + 'px', height: imgBox.height + 'px' }"
                />
                <template v-if="showFaces">
                    <div
                        v-for="(face, i) in analysis?.faces ?? []"
                        :key="i"
                        class="face"
                        :class="{ closed: (face.confidences.eyes_closed ?? 0) >= 0.5 }"
                        :style="{
                            left: imgBox.left + face.box.x0 * imgBox.width + 'px',
                            top: imgBox.top + face.box.y0 * imgBox.height + 'px',
                            width: (face.box.x1 - face.box.x0) * imgBox.width + 'px',
                            height: (face.box.y1 - face.box.y0) * imgBox.height + 'px',
                        }"
                    />
                </template>
            </template>
            <button class="ghost nav prev" @click.stop="move(-1)">‹</button>
            <button class="ghost nav next" @click.stop="move(1)">›</button>
            <button class="ghost closeBtn" :title="t('loupe.close')" @click.stop="close">✕</button>
            <div v-if="stack" class="strip" :class="{ focus: inStack }" @click.stop>
                <img
                    v-for="id in stack.members"
                    :key="id"
                    :src="mediaUrl('thumb', items.find(i => i.id === id)!)"
                    :class="{ on: id === item.id, del: decisions[id]?.verdict === 'delete' }"
                    :title="id + (id === stack.best ? ' ★ ' + t('loupe.bestImage') : '')"
                    @click="go(id)"
                />
                <span class="stripHint">{{ inStack ? t("loupe.stackLeave") : t("loupe.stackEnter") }}</span>
            </div>
        </div>

        <aside class="panel">
            <h2 class="name">{{ item.primary.name }}</h2>
            <div class="muted small">
                {{ item.width }} × {{ item.height }}
                <template v-if="analysis"> · {{ analysis.kind }} · {{ analysis.ms }} ms ({{ analysis.accelerator.toUpperCase() }})</template>
            </div>

            <div class="decide">
                <button :class="{ primary: decision?.verdict !== 'delete' }" @click="setDecision([item.id], { verdict: 'keep' })">{{ t("loupe.keep") }} <kbd>C</kbd></button>
                <button :class="{ danger: decision?.verdict === 'delete' }" @click="setDecision([item.id], { verdict: 'delete' })">{{ t("loupe.delete") }} <kbd>X</kbd></button>
                <button v-if="decision?.source === 'manual'" class="ghost" :title="t('loupe.reset')" @click="resetDecision([item.id])">↺</button>
            </div>
            <label v-if="item.raw" class="rawToggle">
                <input type="checkbox" :checked="decision?.keepRaw" @change="setDecision([item.id], { keepRaw: ($event.target as HTMLInputElement).checked })" />
                {{ t("loupe.keepRaw", { ext: item.raw.ext.toUpperCase() }) }} <kbd>R</kbd>
            </label>

            <section v-if="judgement?.reasons.length || judgement?.hints.length">
                <div v-for="r in judgement.reasons" :key="r.tag" class="reason">✕ {{ reasonText(r) }}</div>
                <div v-for="h in judgement.hints" :key="h" class="hint">⚑ {{ tagLabel(h) }}</div>
            </section>

            <section v-if="analysis?.scores">
                <h3>{{ t("loupe.ratings") }}</h3>
                <div v-for="[label, v] in [[t('loupe.aesthetic'), analysis.scores.aesthetic], [t('loupe.keeper'), analysis.scores.keeper], [t('loupe.cover'), analysis.scores.cover]] as [string, number][]" :key="label" class="score">
                    <span>{{ label }}</span>
                    <div class="progress"><div :style="{ width: pct(v) }" /></div>
                    <span class="mono">{{ pct(v) }}</span>
                </div>
                <div v-if="analysis.sharpness" class="score">
                    <span>{{ t("loupe.sharpness") }}</span>
                    <div class="progress"><div :style="{ width: pct(analysis.sharpness.score) }" /></div>
                    <span class="mono">{{ pct(analysis.sharpness.score) }}</span>
                </div>
                <div class="toggles">
                    <label><input v-model="showBlur" type="checkbox" /> {{ t("loupe.blurMap") }} <kbd>B</kbd></label>
                    <label v-if="analysis.faces.length"><input v-model="showFaces" type="checkbox" /> {{ t("loupe.faces", { count: analysis.faces.length }) }} <kbd>F</kbd></label>
                </div>
            </section>

            <section v-if="tags.length">
                <h3>{{ t("loupe.tags") }}</h3>
                <div class="tags">
                    <span v-for="[tag, v] in tags" :key="tag" class="tag" :class="{ strong: v >= 0.9 }">{{ tagLabel(tag) }} <span class="muted">{{ formatNumber(v, 2) }}</span></span>
                </div>
            </section>

            <section v-if="details">
                <h3>{{ t("loupe.metadata") }}</h3>
                <table class="meta">
                    <tr v-for="[label, v] in rows" :key="label"><td class="muted">{{ label }}</td><td>{{ v }}</td></tr>
                </table>
                <h3>{{ t("loupe.files") }}</h3>
                <table class="meta">
                    <tr v-for="f in details.files" :key="f.name"><td class="muted">{{ t(`file.${f.role}`) }}</td><td class="mono">{{ f.name }}</td><td class="mono right">{{ formatBytes(f.size) }}</td></tr>
                </table>
                <button v-if="item.kind === 'video'" @click="rpc.openExternal({ id: item.id })">{{ t("loupe.openPlayer") }}</button>
            </section>
            <div v-else class="muted">{{ t("loupe.readingMeta") }}</div>
        </aside>
    </div>
</template>

<style scoped>
.loupe {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    grid-template-columns: 1fr 360px;
    background: #0b0c0e;
}
.stage { position: relative; overflow: hidden; cursor: zoom-in; }
.stage.zoom { cursor: zoom-out; }
.stage.isVideo { cursor: default; }
video.fit { background: #000; }
.videoState {
    position: absolute;
    top: 45%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1;
    padding: 8px 14px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.7);
}
.bad { color: var(--delete); }
.fit { width: 100%; height: 100%; object-fit: contain; display: block; padding: 16px 16px 96px; }
.full { width: 100%; height: 100%; object-fit: none; display: block; }
/* Full width of the photo column, flush under the window's title bar. */
.verdictBars { position: absolute; top: 0; left: 0; right: 0; height: 6px; display: flex; gap: 4px; }
.bar { flex: 1; border-radius: 3px; }
.bar.keep { background: var(--accent); }
.bar.del { background: var(--delete); }
.overlay-map { position: absolute; pointer-events: none; image-rendering: auto; }
.face { position: absolute; border: 2px solid var(--keep); border-radius: 4px; pointer-events: none; }
.face.closed { border-color: var(--warn); }
.nav { position: absolute; top: 45%; font-size: 40px; padding: 4px 14px; opacity: 0.6; }
.nav:hover { opacity: 1; }
.prev { left: 6px; }
.next { right: 6px; }
.closeBtn { position: absolute; top: 8px; right: 8px; font-size: 18px; }
.strip {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 8px;
    display: flex;
    gap: 6px;
    justify-content: center;
    align-items: center;
    cursor: default;
}
.strip.focus img.on { border-color: var(--keep); box-shadow: 0 0 0 2px var(--keep); }
/* Beside the thumbnails rather than above them: above, it ran into the photo's bottom edge. */
.stripHint { align-self: center; margin-left: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.strip img { height: 72px; border-radius: 4px; border: 2px solid transparent; cursor: pointer; opacity: 0.85; }
.strip img.on { border-color: var(--accent); opacity: 1; }
.strip img.del { opacity: 0.35; }
.panel {
    background: var(--bg-2);
    border-left: 1px solid var(--line);
    padding: 16px;
    overflow-y: auto;
}
.name { font-size: 17px; margin: 0 0 4px; word-break: break-all; }
.small { font-size: 12px; }
.decide { display: flex; gap: 6px; margin: 14px 0 8px; }
.rawToggle { display: flex; gap: 6px; align-items: center; color: var(--raw); }
section { margin-top: 18px; }
h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 14px 0 6px; }
.reason { color: var(--delete); }
.hint { color: var(--warn); }
.score { display: grid; grid-template-columns: 70px 1fr 42px; gap: 8px; align-items: center; margin: 4px 0; }
.toggles { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { background: var(--bg-3); border-radius: 4px; padding: 2px 6px; font-size: 12px; }
.tag.strong { border: 1px solid var(--accent); }
.meta { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.meta td { padding: 2px 4px 2px 0; vertical-align: top; }
.right { text-align: right; white-space: nowrap; }
</style>
