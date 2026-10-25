<script setup lang="ts" vapor>
import { computed } from "vue";

import { expanded, selected, type Entry } from "../gallery.ts";
import type { Reason } from "../../shared/types.ts";
import { formatNumber, t, tagLabel } from "../i18n/index.ts";
import { analyses, decisions, judgements, mediaUrl, setDecision, stackOf } from "../state.ts";

const props = defineProps<{ entry: Entry }>();
const emit = defineEmits<{ select: []; open: [] }>();

const item = computed(() => props.entry.item);
const decision = computed(() => decisions[item.value.id]);
const judgement = computed(() => judgements.value[item.value.id]);
const analysed = computed(() => !!analyses.value[item.value.id]);
const isDelete = computed(() => decision.value?.verdict === "delete");
const isBest = computed(() => stackOf.value.get(item.value.id)?.best === item.value.id);
const rawLabel = computed(() => item.value.raw?.ext.toUpperCase());
// A collapsed stack's tile stands for all its members: keep it highlighted while the detail
// view shows one of the others.
const isSelected = computed(() =>
    selected.value === item.value.id
    || (props.entry.stackSize > 0 && !!selected.value && stackOf.value.get(selected.value)?.id === props.entry.stackId && !expanded.has(props.entry.stackId!)),
);

function reasonText(r: Reason): string {
    if (r.tag === "duplicate") return t("reason.duplicate", { of: r.of ?? "" });
    return r.confidence === undefined ? tagLabel(r.tag) : `${tagLabel(r.tag)} ${formatNumber(r.confidence, 2)}`;
}

const tooltip = computed(() =>
    [
        item.value.primary.name,
        ...(judgement.value?.reasons ?? []).map(reasonText),
        ...(judgement.value?.hints ?? []).map(h => t("tile.hint", { hint: tagLabel(h) })),
    ].join("\n"),
);

function toggleStack(e: MouseEvent) {
    e.stopPropagation();
    const id = props.entry.stackId;
    if (!id) return;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
}

function toggleVerdict(e: MouseEvent) {
    e.stopPropagation();
    void setDecision([item.value.id], { verdict: isDelete.value ? "keep" : "delete" });
}

function toggleRaw(e: MouseEvent) {
    e.stopPropagation();
    void setDecision([item.value.id], { keepRaw: !decision.value?.keepRaw });
}
</script>

<template>
    <div
        class="tile"
        :class="{ sel: isSelected, del: isDelete, member: entry.inStack, stacked: entry.stackSize > 0 }"
        :title="tooltip"
        @click="emit('select')"
        @dblclick="emit('open')"
    >
        <img :src="mediaUrl('thumb', item)" loading="lazy" decoding="async" draggable="false" />
        <div class="top">
            <span v-if="entry.stackSize" class="badge stack" :title="t('tile.toggleStack')" @click="toggleStack">
                ▤ {{ entry.stackSize }}
            </span>
            <span v-if="isBest && entry.stackSize === 0" class="badge stack">★</span>
            <span v-if="item.kind === 'video'" class="badge">▶ {{ t("tile.video") }}</span>
            <span v-if="item.kind === 'raw-only'" class="badge raw">{{ item.primary.ext.toUpperCase() }}</span>
            <span v-if="item.kind === 'archived'" class="badge" :title="t('tile.archived')">JXL</span>
            <span v-if="item.motion || item.embeddedMotion" class="badge" :title="t('tile.motion')">◉ {{ t("tile.live") }}</span>
            <span v-if="item.hasGainMap" class="badge warn" :title="t('tile.hdrLost')">HDR</span>
            <div class="grow" />
            <span
                v-if="item.raw"
                class="badge raw"
                :class="{ kept: decision?.keepRaw }"
                :title="decision?.keepRaw ? t('tile.rawKept') : t('tile.rawDeleted')"
                @click="toggleRaw"
            >{{ rawLabel }}{{ decision?.keepRaw ? " ✓" : "" }}</span>
        </div>
        <div class="bottom">
            <span v-if="isDelete" class="badge del" @click="toggleVerdict">✕ {{ judgement?.reasons[0] ? reasonText(judgement.reasons[0]) : t("tile.delete") }}</span>
            <span v-else-if="judgement?.hints.length" class="badge warn">⚑ {{ judgement.hints.map(tagLabel).join(", ") }}</span>
            <span v-else-if="!analysed && item.kind !== 'video'" class="badge muted">…</span>
            <div class="grow" />
            <span v-if="decision?.source === 'manual'" class="badge" :title="t('tile.manual')">✎</span>
        </div>
    </div>
</template>

<style scoped>
.tile {
    position: absolute;
    top: 0;
    left: 0;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-2);
    border: 2px solid transparent;
    cursor: pointer;
    user-select: none;
}
.tile img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
}
.tile.sel { border-color: var(--accent); }
.tile.del img { opacity: 0.35; filter: grayscale(0.6); }
.tile.del { border-color: rgba(255, 93, 93, 0.55); }
.tile.del.sel { border-color: var(--accent); }
.tile.member { background: #1d2430; }
.tile.stacked { box-shadow: 4px 4px 0 -1px var(--bg-3), 8px 8px 0 -2px var(--line); }
.top, .bottom {
    position: absolute;
    left: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
    align-items: center;
}
.top { top: 6px; }
.bottom { bottom: 6px; }
.grow { flex: 1; }
.bottom .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
</style>
