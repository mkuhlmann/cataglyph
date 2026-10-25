import { createVaporApp, watchEffect } from "vue";

import App from "./App.vue";
import "./style.css";
import * as gallery from "./gallery.ts";
import { locale } from "./i18n/index.ts";
import * as state from "./state.ts";

createVaporApp(App).mount("#app");

watchEffect(() => {
    document.documentElement.lang = locale.value;
});

// Handle for driving the UI from the CEF DevTools (remote debugging is on in dev builds):
// `__ingest.openFolder("/path")`. Not used by the app itself.
(window as unknown as { __ingest: unknown }).__ingest = { state, gallery };
