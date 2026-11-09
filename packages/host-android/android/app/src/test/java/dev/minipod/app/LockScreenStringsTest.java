package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.HashMap;
import java.util.Map;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/** Localized lock-screen button labels (`values`, `values-zh-rCN`, `values-ja`). */
public class LockScreenStringsTest {

    private static File resDir() {
        // Gradle runs unit tests with the module (`app/`) as working directory.
        File[] candidates = {
            new File("src/main/res"),
            new File("app/src/main/res"),
        };
        for (File c : candidates) {
            if (new File(c, "values/strings.xml").isFile()) return c;
        }
        throw new AssertionError("res dir not found from " + new File(".").getAbsolutePath());
    }

    private static Map<String, String> readStrings(String valuesDir) throws Exception {
        File file = new File(new File(resDir(), valuesDir), "strings.xml");
        assertTrue("missing " + file, file.isFile());
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        // Hardened parser: no DTDs / external entities.
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setExpandEntityReferences(false);
        DocumentBuilder builder = factory.newDocumentBuilder();
        Document doc = builder.parse(file);
        NodeList nodes = doc.getElementsByTagName("string");
        Map<String, String> out = new HashMap<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element el = (Element) nodes.item(i);
            out.put(el.getAttribute("name"), el.getTextContent());
        }
        return out;
    }

    @Test
    public void english_defaultLabels() throws Exception {
        Map<String, String> s = readStrings("values");
        assertEquals("Rewind 10 seconds", s.get("lock_screen_rewind_10"));
        assertEquals("Fast-forward 30 seconds", s.get("lock_screen_fast_forward_30"));
        assertEquals("Podcasts Playback", s.get("playback_channel_name"));
    }

    @Test
    public void simplifiedChinese_labels() throws Exception {
        Map<String, String> s = readStrings("values-zh-rCN");
        assertEquals("快退 10 秒", s.get("lock_screen_rewind_10"));
        assertEquals("快进 30 秒", s.get("lock_screen_fast_forward_30"));
        assertTrue(s.containsKey("playback_channel_name"));
    }

    @Test
    public void japanese_labels() throws Exception {
        Map<String, String> s = readStrings("values-ja");
        assertEquals("10秒戻す", s.get("lock_screen_rewind_10"));
        assertEquals("30秒送る", s.get("lock_screen_fast_forward_30"));
        assertTrue(s.containsKey("playback_channel_name"));
    }

    @Test
    public void everyTranslatableDefaultStringIsTranslated() throws Exception {
        Map<String, String> en = readStrings("values");
        for (String locale : new String[] {"values-zh-rCN", "values-ja"}) {
            Map<String, String> loc = readStrings(locale);
            for (String key : new String[] {
                "app_name", "title_activity_main", "lock_screen_rewind_10",
                "lock_screen_fast_forward_30", "playback_channel_name",
                "download_channel_name", "download_notification_running",
                "download_notification_queued",
            }) {
                assertTrue(key + " in values", en.containsKey(key));
                assertTrue(key + " in " + locale, loc.containsKey(key));
            }
        }
    }

    @Test
    public void downloadNotificationStrings_keepPositionalPlaceholders() throws Exception {
        for (String locale : new String[] {"values", "values-zh-rCN", "values-ja"}) {
            Map<String, String> s = readStrings(locale);
            assertTrue(locale, s.get("download_notification_queued").contains("%1$d"));
            assertTrue(locale, s.get("download_notification_queued").contains("%2$d"));
            assertTrue(locale, s.get("download_notification_running").contains("%d"));
        }
        assertEquals("播客下载", readStrings("values-zh-rCN").get("download_channel_name"));
    }
}
