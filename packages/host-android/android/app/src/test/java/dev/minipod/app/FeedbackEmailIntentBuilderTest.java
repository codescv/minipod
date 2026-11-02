package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class FeedbackEmailIntentBuilderTest {

    private static final String SELF = "dev.minipod.app";

    @Test
    public void mailtoUri_encodesRecipient() {
        assertEquals("mailto:agent@example.com", FeedbackEmailIntentBuilder.mailtoUri(" agent@example.com "));
        assertEquals("mailto:", FeedbackEmailIntentBuilder.mailtoUri(null));
        assertEquals("mailto:a%20b@example.com", FeedbackEmailIntentBuilder.mailtoUri("a b@example.com"));
    }

    @Test
    public void orderEmailPackages_prefersConcreteMailtoDefault() {
        List<String> ordered = FeedbackEmailIntentBuilder.orderEmailPackages(
            "com.microsoft.office.outlook",
            "com.microsoft.office.outlook.compose.ComposeLauncherActivity",
            Arrays.asList("com.google.android.gm", "com.microsoft.office.outlook"),
            SELF
        );
        assertEquals(Arrays.asList("com.microsoft.office.outlook", "com.google.android.gm"), ordered);
    }

    @Test
    public void orderEmailPackages_skipsSystemResolverAndPrefersGmail() {
        List<String> ordered = FeedbackEmailIntentBuilder.orderEmailPackages(
            "android",
            "com.android.internal.app.ResolverActivity",
            Arrays.asList("com.example.mail", "com.google.android.gm", "com.example.mail", SELF),
            SELF
        );
        assertEquals(Arrays.asList("com.google.android.gm", "com.example.mail"), ordered);

        assertTrue(FeedbackEmailIntentBuilder.orderEmailPackages(
            "com.android.intentresolver", "com.android.intentresolver.ChooserActivity", null, SELF
        ).isEmpty());
        assertFalse(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.foo", "com.foo.ResolverActivity", SELF));
        assertTrue(FeedbackEmailIntentBuilder.isConcreteEmailApp("com.google.android.gm", null, SELF));
    }

    @Test
    public void sendTypeCandidates_startWithAttachmentType() {
        assertEquals(
            Arrays.asList("image/jpeg", "image/*", "*/*", "message/rfc822"),
            FeedbackEmailIntentBuilder.sendTypeCandidates("image/jpeg")
        );
        assertEquals("image/*", FeedbackEmailIntentBuilder.sendTypeCandidates(null).get(0));
    }

    @Test
    public void plan_directPackageFirstThenSelectorThenChooser() {
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(
            Collections.singletonList(new FeedbackEmailIntentBuilder.SendTarget(
                "com.google.android.gm", "com.google.android.gm.ComposeActivityGmailExternal", "image/jpeg"
            )),
            "agent@example.com",
            "image/jpeg"
        );
        assertEquals(3, plan.size());

        FeedbackEmailIntentBuilder.Spec direct = plan.get(0);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.DIRECT_PACKAGE, direct.strategy);
        assertEquals("image/jpeg", direct.type);
        assertEquals("com.google.android.gm", direct.packageName);
        assertEquals("com.google.android.gm.ComposeActivityGmailExternal", direct.className);
        assertNull(direct.selectorMailto);

        FeedbackEmailIntentBuilder.Spec selector = plan.get(1);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.MAILTO_SELECTOR, selector.strategy);
        assertNull("selector fallback must not call setType", selector.type);
        assertEquals("mailto:agent@example.com", selector.selectorMailto);
        assertNull(selector.packageName);

        FeedbackEmailIntentBuilder.Spec chooser = plan.get(2);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.CHOOSER, chooser.strategy);
        assertEquals("image/jpeg", chooser.type);
        assertNull(chooser.selectorMailto);
    }

    @Test
    public void plan_withoutResolvedEmailAppStartsWithSelector() {
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(null, "a@b.co", "image/png");
        assertEquals(2, plan.size());
        assertEquals(FeedbackEmailIntentBuilder.Strategy.MAILTO_SELECTOR, plan.get(0).strategy);
        assertEquals(FeedbackEmailIntentBuilder.Strategy.CHOOSER, plan.get(1).strategy);
    }

    @Test
    public void plan_neverCombinesTypeAndMailtoSelector() {
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(
            Arrays.asList(
                new FeedbackEmailIntentBuilder.SendTarget("com.google.android.gm", null, "image/*"),
                new FeedbackEmailIntentBuilder.SendTarget("com.example.mail", null, "*/*")
            ),
            "agent@example.com",
            "image/webp"
        );
        for (FeedbackEmailIntentBuilder.Spec spec : plan) {
            assertFalse(spec.strategy + " combines setType + mailto selector", spec.hasType() && spec.hasSelector());
            assertNotNull(spec.strategy);
        }
        try {
            new FeedbackEmailIntentBuilder.Spec(
                FeedbackEmailIntentBuilder.Strategy.MAILTO_SELECTOR, "image/jpeg", null, null, "mailto:"
            );
            fail("Spec must reject setType + mailto: selector");
        } catch (IllegalStateException expected) {
            // ok
        }
    }
}
