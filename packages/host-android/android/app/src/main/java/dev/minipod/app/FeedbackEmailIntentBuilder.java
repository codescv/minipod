package dev.minipod.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * v0.1.25 pure-Java (JVM unit-testable) planning for the Agent Feedback email launch.
 *
 * <p>v0.1.23/v0.1.24 started {@code ACTION_SEND} with {@code setType("image/jpeg")} AND a
 * {@code mailto:} {@code ACTION_SENDTO} selector on the same Intent. Android resolves the
 * selector with the outer Intent's resolved type, so every email app's {@code mailto:} filter
 * failed with {@code MATCH_NO_TYPE}, {@code ActivityNotFoundException} fired, and the generic
 * share sheet (chooser) popped up instead of the email app.
 *
 * <p>The launch is now planned as an ordered list of {@link Spec}s:
 * <ol>
 *   <li>{@link Strategy#DIRECT_PACKAGE}: {@code ACTION_SEND} + MIME type pinned to the email app
 *       package resolved from a {@code mailto:} {@code ACTION_SENDTO} probe (no selector).</li>
 *   <li>{@link Strategy#MAILTO_SELECTOR}: {@code ACTION_SEND} WITHOUT a type plus a
 *       {@code mailto:} selector (so {@code resolveTypeIfNeeded} is {@code null}).</li>
 *   <li>{@link Strategy#CHOOSER}: typed {@code ACTION_SEND} chooser, last resort only.</li>
 * </ol>
 * A {@link Spec} can never carry both a MIME type and a selector.
 */
final class FeedbackEmailIntentBuilder {

    static final String GMAIL_PACKAGE = "com.google.android.gm";

    /** Packages / activities that are system resolvers or choosers, never concrete email apps. */
    private static final Set<String> SYSTEM_RESOLVER_PACKAGES = new LinkedHashSet<>();

    static {
        SYSTEM_RESOLVER_PACKAGES.add("android");
        SYSTEM_RESOLVER_PACKAGES.add("com.android.intentresolver");
        SYSTEM_RESOLVER_PACKAGES.add("com.android.internal.app");
    }

    enum Strategy {
        DIRECT_PACKAGE,
        MAILTO_SELECTOR,
        CHOOSER
    }

    /** Immutable description of one {@code ACTION_SEND} launch attempt. */
    static final class Spec {
        final Strategy strategy;
        /** MIME type for {@code Intent#setType}; {@code null} means "do not call setType". */
        final String type;
        /** Target package for {@code Intent#setPackage}; {@code null} for none. */
        final String packageName;
        /** Target activity class for {@code Intent#setClassName}; {@code null} for none. */
        final String className;
        /** {@code mailto:} URI for an {@code ACTION_SENDTO} selector; {@code null} for none. */
        final String selectorMailto;

        Spec(Strategy strategy, String type, String packageName, String className, String selectorMailto) {
            if (type != null && selectorMailto != null) {
                throw new IllegalStateException(
                    "ACTION_SEND must not combine setType(" + type + ") with a mailto: selector"
                );
            }
            if (className != null && packageName == null) {
                throw new IllegalStateException("className requires packageName");
            }
            this.strategy = strategy;
            this.type = type;
            this.packageName = packageName;
            this.className = className;
            this.selectorMailto = selectorMailto;
        }

        boolean hasType() {
            return type != null;
        }

        boolean hasSelector() {
            return selectorMailto != null;
        }
    }

    /** A resolved {@code ACTION_SEND} activity inside an email package, with the MIME type it accepts. */
    static final class SendTarget {
        final String packageName;
        /** Unique activity class name or {@code null} when several activities match. */
        final String className;
        final String type;

        SendTarget(String packageName, String className, String type) {
            this.packageName = packageName;
            this.className = className;
            this.type = type;
        }
    }

    private FeedbackEmailIntentBuilder() {}

    /** Builds the {@code mailto:} URI (recipient percent-encoded) used for probes and selectors. */
    static String mailtoUri(String to) {
        String recipient = to == null ? "" : to.trim();
        return "mailto:" + encodeRecipient(recipient);
    }

    /** True if {@code packageName}/{@code activityName} names a concrete app rather than a resolver/chooser. */
    static boolean isConcreteEmailApp(String packageName, String activityName, String selfPackage) {
        if (packageName == null || packageName.trim().isEmpty()) return false;
        String pkg = packageName.trim();
        if (SYSTEM_RESOLVER_PACKAGES.contains(pkg)) return false;
        if (selfPackage != null && selfPackage.equals(pkg)) return false;
        if (activityName != null) {
            String lower = activityName.toLowerCase(Locale.ROOT);
            if (lower.endsWith("resolveractivity") || lower.endsWith("chooseractivity")) return false;
        }
        return true;
    }

    /**
     * Orders the candidate email packages for a direct launch: the {@code mailto:} default
     * handler (when concrete) first, then Gmail when installed, then the remaining
     * {@code queryIntentActivities} results in order. Duplicates and non-concrete entries
     * (system resolver, own package) are dropped.
     */
    static List<String> orderEmailPackages(
        String defaultPackage,
        String defaultActivity,
        List<String> candidatePackages,
        String selfPackage
    ) {
        LinkedHashSet<String> ordered = new LinkedHashSet<>();
        if (isConcreteEmailApp(defaultPackage, defaultActivity, selfPackage)) {
            ordered.add(defaultPackage.trim());
        }
        List<String> candidates = candidatePackages == null
            ? Collections.<String>emptyList()
            : candidatePackages;
        for (String pkg : candidates) {
            if (GMAIL_PACKAGE.equals(pkg) && isConcreteEmailApp(pkg, null, selfPackage)) {
                ordered.add(pkg);
            }
        }
        for (String pkg : candidates) {
            if (isConcreteEmailApp(pkg, null, selfPackage)) ordered.add(pkg.trim());
        }
        return new ArrayList<>(ordered);
    }

    /**
     * MIME types to probe (in order) when looking for an {@code ACTION_SEND} activity inside an
     * email package: the attachment type, its {@code image/*} wildcard, then generic fallbacks.
     */
    static List<String> sendTypeCandidates(String mimeType) {
        LinkedHashSet<String> types = new LinkedHashSet<>();
        String normalized = FeedbackAttachmentNames.normalizeMime(mimeType);
        types.add(normalized);
        int slash = normalized.indexOf('/');
        if (slash > 0) types.add(normalized.substring(0, slash) + "/*");
        types.add("*/*");
        types.add("message/rfc822");
        return new ArrayList<>(types);
    }

    /** Direct launch into a resolved email app: typed {@code ACTION_SEND}, package-pinned, no selector. */
    static Spec directSpec(SendTarget target) {
        return new Spec(Strategy.DIRECT_PACKAGE, target.type, target.packageName, target.className, null);
    }

    /** Selector fallback: untyped {@code ACTION_SEND} + {@code mailto:} selector. */
    static Spec selectorSpec(String to) {
        return new Spec(Strategy.MAILTO_SELECTOR, null, null, null, mailtoUri(to));
    }

    /** Last-resort chooser (share sheet): typed {@code ACTION_SEND}, no selector, no package. */
    static Spec chooserSpec(String mimeType) {
        return new Spec(Strategy.CHOOSER, FeedbackAttachmentNames.normalizeMime(mimeType), null, null, null);
    }

    /**
     * Full ordered launch plan: one {@link Strategy#DIRECT_PACKAGE} spec per resolved email
     * {@link SendTarget}, then the {@link Strategy#MAILTO_SELECTOR} fallback, then the chooser.
     */
    static List<Spec> plan(List<SendTarget> directTargets, String to, String mimeType) {
        List<Spec> specs = new ArrayList<>();
        if (directTargets != null) {
            for (SendTarget target : directTargets) {
                if (target != null && target.packageName != null) specs.add(directSpec(target));
            }
        }
        specs.add(selectorSpec(to));
        specs.add(chooserSpec(mimeType));
        return specs;
    }

    /** RFC 3986-style encoding equivalent to {@code Uri.encode(recipient, "@")}. */
    private static String encodeRecipient(String value) {
        StringBuilder sb = new StringBuilder();
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (byte b : bytes) {
            int c = b & 0xff;
            boolean unreserved = (c >= 'A' && c <= 'Z')
                || (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9')
                || c == '-' || c == '_' || c == '.' || c == '~' || c == '@' || c == '+';
            if (unreserved) {
                sb.append((char) c);
            } else {
                sb.append('%').append(String.format(Locale.ROOT, "%02X", c));
            }
        }
        return sb.toString();
    }
}
