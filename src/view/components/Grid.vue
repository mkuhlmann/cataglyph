<script setup lang="ts" vapor>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { entries, handleKey, indexOf, loupe, selected, tileSize } from "../gallery.ts";
import { t } from "../i18n/index.ts";
import { items } from "../state.ts";
import Tile from "./Tile.vue";

// A virtualised grid: only the rows in (and just around) the viewport are rendered, as
// absolutely positioned tiles. A 2000-photo folder would otherwise mean 2000 live <img>
// elements, each pulling a thumbnail and holding a decoded bitmap.

const GAP = 8;
const OVERSCAN_ROWS = 3;

const scroller = ref<HTMLElement | null>(null);
const width = ref(1000);
const height = ref(800);
const scrollTop = ref(0);

const cols = computed(() => Math.max(1, Math.floor((width.value - GAP) / (tileSize.value + GAP))));
const cell = computed(() => (width.value - GAP) / cols.value);
const rowHeight = computed(() => cell.value);
const rows = computed(() => Math.ceil(entries.value.length / cols.value));

const visible = computed(() => {
    const first = Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - OVERSCAN_ROWS);
    const last = Math.min(rows.value, Math.ceil((scrollTop.value + height.value) / rowHeight.value) + OVERSCAN_ROWS);
    const out = [];
    for (let i = first * cols.value; i < Math.min(entries.value.length, last * cols.value); i++) {
        out.push({ entry: entries.value[i]!, x: GAP + (i % cols.value) * cell.value, y: GAP + Math.floor(i / cols.value) * rowHeight.value });
    }
    return out;
});

let observer: ResizeObserver | null = null;
const onKey = (e: KeyboardEvent) => void handleKey(e, cols.value);

onMounted(() => {
    observer = new ResizeObserver(([e]) => {
        if (!e) return;
        width.value = e.contentRect.width;
        height.value = e.contentRect.height;
    });
    if (scroller.value) observer.observe(scroller.value);
    window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
    observer?.disconnect();
    window.removeEventListener("keydown", onKey);
});

// Keep the selection in view when it moves by keyboard.
watch(selected, id => {
    const el = scroller.value;
    const i = indexOf(id);
    if (!el || i < 0 || loupe.value) return;
    const top = GAP + Math.floor(i / cols.value) * rowHeight.value;
    if (top < el.scrollTop) el.scrollTop = top - GAP;
    else if (top + rowHeight.value > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight.value - el.clientHeight + GAP;
});

function open(id: string) {
    selected.value = id;
    loupe.value = id;
}
</script>

<template>
    <div ref="scroller" class="scroller" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
        <div class="space" :style="{ height: rows * rowHeight + GAP + 'px' }">
            <Tile
                v-for="v in visible"
                :key="v.entry.item.id"
                :entry="v.entry"
                :style="{ transform: `translate(${v.x}px, ${v.y}px)`, width: cell - GAP + 'px', height: rowHeight - GAP + 'px' }"
                @select="selected = v.entry.item.id"
                @open="open(v.entry.item.id)"
            />
        </div>
        <div v-if="!entries.length" class="empty muted">
            {{ items.length ? t("grid.emptyFilter") : t("grid.emptyFolder") }}
        </div>
    </div>
</template>

<style scoped>
.scroller {
    flex: 1;
    overflow-y: auto;
    position: relative;
}
.space { position: relative; }
.empty { position: absolute; top: 40%; width: 100%; text-align: center; }
</style>
