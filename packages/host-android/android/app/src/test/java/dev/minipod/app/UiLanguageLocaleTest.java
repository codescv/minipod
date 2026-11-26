package dev.minipod.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Pure JVM tests for Web -> Android locale tag mapping. */
public class UiLanguageLocaleTest {
    @Test
    public void mapsSupportedLanguagesAndSystemFallback() {
        assertEquals("", UiLanguageLocale.toLanguageTags("system"));
        assertEquals("", UiLanguageLocale.toLanguageTags(null));
        assertEquals("", UiLanguageLocale.toLanguageTags(""));
        assertEquals("", UiLanguageLocale.toLanguageTags("fr-FR"));
        assertEquals("zh-CN", UiLanguageLocale.toLanguageTags("zh-CN"));
        assertEquals("zh-CN", UiLanguageLocale.toLanguageTags("zh-Hans"));
        assertEquals("en", UiLanguageLocale.toLanguageTags("en"));
        assertEquals("ja", UiLanguageLocale.toLanguageTags("ja"));
    }
}
