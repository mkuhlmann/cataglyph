<script setup lang="ts" vapor>
import { computed, onMounted, ref } from "vue";

import type { CachePart, CacheUsage } from "../../shared/rpc.ts";
import { formatBytes, formatNumber, t } from "../i18n/index.ts";
import { eye, rpc } from "../state.ts";

const PARTS: CachePart[] = ["thumbs", "video", "analyses", "browser"];

const usage = ref<CacheUsage | null>(null);
const busy = ref<CachePart[] | null>(null);
const failure = ref<string | null>(null);

// Eye reads display sources from thumbs/ and writes analyses as it goes (app.ts refuses too).
const analysing = computed(() => eye.value?.state === "running" || eye.value?.state === "starting");
const blocked = (part: CachePart) => analysing.value && (part === "thumbs" || part === "analyses");

const total = computed(() => (usage.value ? PARTS.reduce((sum, p) => sum + usage.value!.parts[p].bytes, 0) : 0));

async function load() {
    failure.value = null;
    try {
        usage.value = await rpc.cacheUsage({});
    } catch (err) {
        failure.value = (err as Error).message;
    }
}

async function clear(parts: CachePart[]) {
    busy.value = parts;
    failure.value = null;
    try {
        usage.value = await rpc.clearCache({ parts });
    } catch (err) {
        failure.value = (err as Error).message;
    } finally {
        busy.value = null;
    }
}

function clearAll() {
    void clear(PARTS.filter(p => !blocked(p)));
}

function openDir() {
    if (usage.value) void rpc.openExternal({ path: usage.value.dir });
}

onMounted(load);
</script>

<template>
    <section>
        <p class="muted intro">{{ t("cache.intro") }}</p>
        <div v-if="!usage && !failure" class="muted">{{ t("cache.loading") }}</div>
        <table v-if="usage" class="parts">
            <tbody>
                <tr v-for="part in PARTS" :key="part">
                    <td>
                        <div>{{ t(`cache.part.${part}`) }}</div>
                        <div class="muted small">{{ t(`cache.part.${part}.hint`) }}</div>
                    </td>
                    <td class="num">
                        <div>{{ formatBytes(usage.parts[part].bytes) }}</div>
                        <div v-if="usage.parts[part].count !== null" class="muted small">
                            {{ t(part === "analyses" ? "cache.entries" : "cache.files", { count: formatNumber(usage.parts[part].count ?? 0) }) }}
                        </div>
                    </td>
                    <td class="act">
                        <button
                            :disabled="busy !== null || blocked(part) || usage.parts[part].bytes === 0"
                            :title="blocked(part) ? t('cache.blocked') : undefined"
                            @click="clear([part])"
                        >{{ busy?.includes(part) ? t("cache.clearing") : t("cache.clear") }}</button>
                    </td>
                </tr>
            </tbody>
        </table>
        <p v-if="analysing" class="muted small">{{ t("cache.blocked") }}</p>
        <p v-if="failure" class="bad">{{ failure }}</p>
        <div v-if="usage" class="foot">
            <button class="ghost link mono" :title="t('cache.openDir')" @click="openDir">{{ usage.dir }}</button>
            <button class="danger" :disabled="busy !== null || total === 0" @click="clearAll">
                {{ t("cache.clearAll", { size: formatBytes(total) }) }}
            </button>
        </div>
    </section>
</template>

<style scoped>
.intro { margin: 0 0 12px; font-size: 12.5px; }
.parts { width: 100%; border-collapse: collapse; }
.parts td { padding: 8px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
.parts .num { text-align: right; padding-right: 14px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.parts .act { width: 1%; white-space: nowrap; }
.small { font-size: 12px; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.link { color: var(--accent); padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bad { color: var(--delete); }
</style>
