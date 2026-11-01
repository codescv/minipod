package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class FeedbackAttachmentNamesTest {

    @Test
    public void sanitize_keepsSafeNamesAndExtensions() {
        assertEquals("screenshot.png", FeedbackAttachmentNames.sanitize("screenshot.png", "image/png"));
        assertEquals("bug_report_1.jpg", FeedbackAttachmentNames.sanitize("bug report 1.jpg", "image/jpeg"));
    }

    @Test
    public void sanitize_stripsPathTraversalAndHiddenPrefixes() {
        assertEquals("passwd.png", FeedbackAttachmentNames.sanitize("../../etc/passwd", "image/png"));
        assertEquals("evil.png", FeedbackAttachmentNames.sanitize("C:\\tmp\\..\\evil.png", null));
        assertEquals("hidden.webp", FeedbackAttachmentNames.sanitize(".hidden", "image/webp"));
    }

    @Test
    public void sanitize_fallsBackForEmptyOrNonAsciiNames() {
        assertEquals("feedback_image.png", FeedbackAttachmentNames.sanitize(null, null));
        assertEquals("feedback_image.jpg", FeedbackAttachmentNames.sanitize("截图", "image/jpeg"));
        assertEquals("feedback_image.gif", FeedbackAttachmentNames.sanitize("   ", "image/gif"));
    }

    @Test
    public void sanitize_capsLength() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200; i++) sb.append('a');
        String out = FeedbackAttachmentNames.sanitize(sb + ".png", "image/png");
        assertTrue(out.length() <= FeedbackAttachmentNames.MAX_NAME_LENGTH);
        assertTrue(out.endsWith(".png"));
    }

    @Test
    public void normalizeMimeAndStripDataUrl() {
        assertEquals("image/png", FeedbackAttachmentNames.normalizeMime(" IMAGE/PNG "));
        assertEquals("image/*", FeedbackAttachmentNames.normalizeMime("not a mime"));
        assertEquals("image/*", FeedbackAttachmentNames.normalizeMime(null));
        assertEquals("QUJD", FeedbackAttachmentNames.stripDataUrlPrefix("data:image/png;base64,QUJD"));
        assertEquals("QUJD", FeedbackAttachmentNames.stripDataUrlPrefix("  QUJD "));
    }
}
