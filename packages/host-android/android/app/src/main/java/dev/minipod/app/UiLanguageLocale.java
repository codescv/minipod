package dev.minipod.app;

import androidx.annotation.Nullable;

/**
 * Maps Web UI language settings (`system` | `zh-CN` | `en` | `ja`) to AndroidX
 * `LocaleListCompat.forLanguageTags(...)` tags (`""` clears the per-app override).
 */
final class UiLanguageLocale {
    private UiLanguageLocale() {}

    static String toLanguageTags(@Nullable String language) {
        if (language == null) return "";
        String normalized = language.trim();
        if ("zh-CN".equalsIgnoreCase(normalized) || "zh-Hans".equalsIgnoreCase(normalized)) {
            return "zh-CN";
        }
        if ("en".equalsIgnoreCase(normalized)) {
            return "en";
        }
        if ("ja".equalsIgnoreCase(normalized)) {
            return "ja";
        }
        return "";
    }
}
