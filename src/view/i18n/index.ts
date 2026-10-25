// Minimal i18n: flat message catalogs per locale, `{name}` placeholders, English fallback.
//
// No library: the app has two languages and a few hundred strings, and the only reactive
// input is the locale. `t()` reads `locale.value`, so any template or computed that calls it
// re-renders when the language changes.

import { computed } from "vue";

import { init, settings } from "../state.ts";
import { de } from "./de.ts";
import { en, type MessageKey } from "./en.ts";

export type Locale = "en" | "de";

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = { en, de };

/** "auto" follows the desktop locale (from the main process): German for de-*, else English. */
export const locale = computed<Locale>(() => {
    const chosen = settings.value?.language ?? "auto";
    if (chosen !== "auto") return chosen;
    return (init.value?.systemLocale ?? navigator.language).toLowerCase().startsWith("de") ? "de" : "en";
});

export function t(key: MessageKey, params?: Record<string, string | number>): string {
    const text = catalogs[locale.value][key] ?? en[key] ?? key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/**
 * Human label for an Eye tag. Known tags (types, quality, keep/delete, people, faces) are in
 * the catalogs as `tag.<name>`; the 558 scene tags are not translated and fall back to the
 * tag name with spaces ("fixed_wing_aircraft" -> "fixed wing aircraft").
 */
export function tagLabel(tag: string): string {
    const key = `tag.${tag}` as MessageKey;
    return catalogs[locale.value][key] ?? en[key] ?? tag.replace(/_/g, " ");
}

export function formatNumber(value: number, digits = 0): string {
    return value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${formatNumber(bytes / 1e9, 2)} GB`;
    if (bytes >= 1e6) return `${formatNumber(bytes / 1e6, 1)} MB`;
    return `${formatNumber(Math.round(bytes / 1e3))} KB`;
}
