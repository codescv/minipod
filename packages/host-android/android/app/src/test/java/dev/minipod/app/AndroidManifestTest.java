package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.BeforeClass;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * bc737679: the source `AndroidManifest.xml` declares everything headless resume / background
 * playback needs (Media3 1.5.1 only enables the persistent media-button route when the
 * `MediaButtonReceiver` is in the manifest).
 */
public class AndroidManifestTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static Document manifest;

    @BeforeClass
    public static void parse() throws Exception {
        File f = new File("src/main/AndroidManifest.xml");
        if (!f.exists()) f = new File("app/src/main/AndroidManifest.xml");
        assertTrue("manifest not found from " + new File(".").getAbsolutePath(), f.exists());
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setNamespaceAware(true);
        manifest = dbf.newDocumentBuilder().parse(f);
    }

    private static String attr(Element e, String name) {
        return e.getAttributeNS(ANDROID_NS, name);
    }

    private static Element component(String tag, String name) {
        NodeList nodes = manifest.getElementsByTagName(tag);
        for (int i = 0; i < nodes.getLength(); i++) {
            Element e = (Element) nodes.item(i);
            if (name.equals(attr(e, "name"))) return e;
        }
        return null;
    }

    private static List<String> actions(Element component) {
        List<String> out = new ArrayList<>();
        NodeList nodes = component.getElementsByTagName("action");
        for (int i = 0; i < nodes.getLength(); i++) {
            out.add(attr((Element) nodes.item(i), "name"));
        }
        return out;
    }

    @Test
    public void mediaButtonReceiver_isExported_withMediaButtonFilter() {
        Element receiver = component("receiver", "androidx.media3.session.MediaButtonReceiver");
        assertNotNull("androidx.media3.session.MediaButtonReceiver must be declared", receiver);
        assertEquals("true", attr(receiver, "exported"));
        assertEquals(List.of("android.intent.action.MEDIA_BUTTON"), actions(receiver));
    }

    @Test
    public void playbackService_isMediaPlaybackForegroundService_withSessionFilters() {
        Element service = component("service", ".PlaybackService");
        assertNotNull(service);
        assertEquals("mediaPlayback", attr(service, "foregroundServiceType"));
        assertEquals("true", attr(service, "exported"));
        assertEquals("false", attr(service, "stopWithTask"));
        List<String> actions = actions(service);
        assertTrue(actions.contains("androidx.media3.session.MediaSessionService"));
        assertTrue(actions.contains("android.media.browse.MediaBrowserService"));
        // `MediaButtonReceiver` resolves exactly one service for the session action.
        int sessionServices = 0;
        NodeList services = manifest.getElementsByTagName("service");
        for (int i = 0; i < services.getLength(); i++) {
            if (actions((Element) services.item(i)).contains("androidx.media3.session.MediaSessionService")) {
                sessionServices++;
            }
        }
        assertEquals(1, sessionServices);
    }

    @Test
    public void requiredPermissions_declared() {
        Set<String> perms = new HashSet<>();
        NodeList nodes = manifest.getElementsByTagName("uses-permission");
        for (int i = 0; i < nodes.getLength(); i++) {
            perms.add(attr((Element) nodes.item(i), "name"));
        }
        for (String p : List.of(
            "android.permission.FOREGROUND_SERVICE",
            "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
            "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
            "android.permission.WAKE_LOCK",
            "android.permission.ACCESS_WIFI_STATE",
            "android.permission.POST_NOTIFICATIONS",
            "android.permission.ACCESS_NETWORK_STATE",
            "android.permission.INTERNET")) {
            assertTrue("missing " + p, perms.contains(p));
        }
    }

    /** 4daa0030: background downloads survive Android 14-17 freezer / Doze via a dataSync FGS. */
    @Test
    public void episodeDownloadService_isPrivateDataSyncForegroundService() {
        Element service = component("service", ".EpisodeDownloadService");
        assertNotNull(".EpisodeDownloadService must be declared", service);
        assertEquals("dataSync", attr(service, "foregroundServiceType"));
        assertEquals("false", attr(service, "exported"));
        assertEquals("false", attr(service, "stopWithTask"));
        assertTrue("no intent filters on a private service", actions(service).isEmpty());
    }
}
