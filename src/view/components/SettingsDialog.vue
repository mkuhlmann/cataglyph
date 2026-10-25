<script setup lang="ts" vapor>
import { ref } from "vue";

import { DEFAULT_SETTINGS, type Settings, type Thresholds } from "../../shared/types.ts";
import { t } from "../i18n/index.ts";
import { saveSettings, settings } from "../state.ts";
import CachePanel from "./CachePanel.vue";

const emit = defineEmits<{ close: [] }>();

// The cache tab acts right away on its own buttons; Save/Cancel only concern the general tab,
// whose edits survive switching tabs.
const tab = ref<"general" | "cache">("general");

const copy = ref<Settings>(structuredClone(settings.value ?? DEFAULT_SETTINGS));
const saving = ref(false);
const failure = ref<string | null>(null);

const fields: Exclude<keyof Thresholds, "flagDuplicates">[] = ["blurry", "unusable", "accidental", "technical_flaw", "test_or_duplicate_shot", "hint"];

function reset() {
    copy.value.thresholds = { ...DEFAULT_SETTINGS.thresholds };
}

async function save() {
    saving.value = true;
    failure.value = null;
    try {
        await saveSettings(JSON.parse(JSON.stringify(copy.value)) as Settings);
        emit("close");
    } catch (err) {
        failure.value = (err as Error).message;
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <div class="overlay" @click.self="emit('close')">
        <div class="dialog">
            <h2>{{ t("settings.title") }}</h2>

            <div class="tabs" role="tablist">
                <button role="tab" :class="{ active: tab === 'general' }" :aria-selected="tab === 'general'" @click="tab = 'general'">{{ t("settings.tab.general") }}</button>
                <button role="tab" :class="{ active: tab === 'cache' }" :aria-selected="tab === 'cache'" @click="tab = 'cache'">{{ t("settings.tab.cache") }}</button>
            </div>

            <CachePanel v-if="tab === 'cache'" />

            <template v-else>
                <section>
                    <div class="head">
                        <h3>{{ t("settings.classification") }}</h3>
                        <button class="ghost link" @click="reset">{{ t("settings.defaults") }}</button>
                    </div>
                    <div class="grid">
                        <label v-for="key in fields" :key="key" class="field">
                            <span>{{ t(`settings.threshold.${key}`) }} <span class="mono muted">{{ key }}</span></span>
                            <input v-model.number="copy.thresholds[key]" type="number" min="0" max="1" step="0.05" />
                        </label>
                    </div>
                    <label class="check">
                        <input v-model="copy.thresholds.flagDuplicates" type="checkbox" />
                        {{ t("settings.flagDuplicates") }}
                    </label>
                    <label class="check">
                        <input v-model="copy.useGpu" type="checkbox" />
                        {{ t("settings.useGpu") }}
                    </label>
                </section>

                <section>
                    <h3>{{ t("settings.language") }}</h3>
                    <label class="field">
                        <span>{{ t("settings.language") }}</span>
                        <select v-model="copy.language">
                            <option value="auto">{{ t("settings.language.auto") }}</option>
                            <option value="en">{{ t("settings.language.en") }}</option>
                            <option value="de">{{ t("settings.language.de") }}</option>
                        </select>
                    </label>
                </section>

                <section>
                    <h3>{{ t("settings.display") }}</h3>
                    <label class="check">
                        <input v-model="copy.verdictBar" type="checkbox" />
                        {{ t("settings.verdictBar") }}
                    </label>
                    <label class="check">
                        <input v-model="copy.transcodeVideos" type="checkbox" />
                        {{ t("settings.transcodeVideos") }}
                    </label>
                </section>

                <section>
                    <h3>{{ t("settings.deleting") }}</h3>
                    <label class="field">
                        <span>{{ t("settings.deleteMode") }}</span>
                        <select v-model="copy.deleteMode">
                            <option value="trash">{{ t("settings.deleteMode.trash") }}</option>
                            <option value="permanent">{{ t("settings.deleteMode.permanent") }}</option>
                        </select>
                    </label>
                    <p class="muted hint">{{ t("settings.jxlHint") }}</p>
                </section>
            </template>

            <p v-if="failure" class="bad">{{ failure }}</p>
            <div class="actions">
                <button @click="emit('close')">{{ t("settings.cancel") }}</button>
                <button class="primary" :disabled="saving" @click="save">{{ t("settings.save") }}</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
section { margin-bottom: 18px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.tabs button { background: transparent; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 12px; color: var(--muted); margin-bottom: -1px; }
.tabs button:hover { color: var(--text); }
.tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.head { display: flex; align-items: baseline; justify-content: space-between; }
.link { color: var(--accent); padding: 0; font-size: 12.5px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin-bottom: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field input, .field select { width: 100%; }
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; margin-top: 8px; }
.hint { margin: 10px 0 0; font-size: 12.5px; }
.bad { color: var(--delete); }
</style>
