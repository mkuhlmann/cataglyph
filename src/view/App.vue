<script setup lang="ts" vapor>
import { onMounted, ref } from "vue";

import ApplyDialog from "./components/ApplyDialog.vue";
import ConvertDialog from "./components/ConvertDialog.vue";
import Grid from "./components/Grid.vue";
import Loupe from "./components/Loupe.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import StartScreen from "./components/StartScreen.vue";
import Toolbar from "./components/Toolbar.vue";
import { loupe } from "./gallery.ts";
import { boot, busy, error, folder, init } from "./state.ts";
import { t } from "./i18n/index.ts";

const dialog = ref<"apply" | "convert" | "settings" | null>(null);

onMounted(async () => {
    try {
        await boot();
    } catch (err) {
        error.value = (err as Error).message;
    }
});
</script>

<template>
    <div class="app">
        <template v-if="init">
            <StartScreen v-if="!folder" />
            <template v-else>
                <Toolbar @open="d => (dialog = d)" />
                <Grid />
            </template>
        </template>
        <div v-if="busy" class="busy">{{ t("app.scanning") }}</div>
        <div v-if="error" class="error" @click="error = null">{{ error }}</div>
        <Loupe v-if="loupe" />
        <ApplyDialog v-if="dialog === 'apply'" @close="dialog = null" />
        <ConvertDialog v-if="dialog === 'convert'" @close="dialog = null" />
        <SettingsDialog v-if="dialog === 'settings'" @close="dialog = null" />
    </div>
</template>

<style scoped>
.app {
    height: 100%;
    display: flex;
    flex-direction: column;
}
.busy, .error {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    padding: 10px 16px;
    border-radius: 8px;
    background: var(--bg-3);
    border: 1px solid var(--line);
    z-index: 100;
}
.error { border-color: var(--delete); color: var(--delete); cursor: pointer; }
</style>
