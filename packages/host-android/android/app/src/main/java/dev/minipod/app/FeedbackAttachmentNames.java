package dev.minipod.app;

import java.util.Locale;

/**
 * Pure-Java helpers for Agent Feedback image attachments (v0.1.23).
 *
 * <p>Kept free of Android APIs so it can be covered by JVM unit tests
 * ({@code ./gradlew testDebugUnitTest}).
 */
final class FeedbackAttachmentNames {
    static final int MAX_NAME_LENGTH = 80;

    private FeedbackAttachmentNames() {}

    /**
     * Returns a filesystem-safe attachment file name: strips any path segments,
     * replaces characters outside {@code [A-Za-z0-9._-]} with {@code _}, trims leading
     * dots, caps the length, and appends an extension derived from {@code mimeType}
     * when the name has none.
     */
    static String sanitize(String name, String mimeType) {
        String base = name == null ? "" : name.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        base = base.replaceAll("^[._]+", "");
        if (base.isEmpty() || base.replace("_", "").isEmpty()) base = "feedback_image";

        String ext = "";
        int dot = base.lastIndexOf('.');
        if (dot > 0 && dot < base.length() - 1) {
            ext = base.substring(dot);
            base = base.substring(0, dot);
        } else {
            if (dot == base.length() - 1) base = base.substring(0, dot);
            ext = extensionForMime(mimeType);
        }
        int maxBase = Math.max(1, MAX_NAME_LENGTH - ext.length());
        if (base.length() > maxBase) base = base.substring(0, maxBase);
        return base + ext;
    }

    /** Maps common image MIME types to a file extension (with leading dot). */
    static String extensionForMime(String mimeType) {
        if (mimeType == null) return ".png";
        switch (mimeType.trim().toLowerCase(Locale.ROOT)) {
            case "image/jpeg":
            case "image/jpg":
                return ".jpg";
            case "image/gif":
                return ".gif";
            case "image/webp":
                return ".webp";
            case "image/heic":
                return ".heic";
            case "image/heif":
                return ".heif";
            case "image/bmp":
                return ".bmp";
            default:
                return ".png";
        }
    }

    /** Normalizes the MIME type used for {@code Intent#setType}; defaults to {@code image/*}. */
    static String normalizeMime(String mimeType) {
        if (mimeType == null) return "image/*";
        String trimmed = mimeType.trim().toLowerCase(Locale.ROOT);
        return trimmed.matches("^[a-z0-9.+-]+/[a-z0-9.+*-]+$") ? trimmed : "image/*";
    }

    /** Removes an optional {@code data:<mime>;base64,} prefix from a Base64 payload. */
    static String stripDataUrlPrefix(String base64) {
        if (base64 == null) return "";
        String trimmed = base64.trim();
        if (trimmed.startsWith("data:")) {
            int comma = trimmed.indexOf(',');
            if (comma >= 0) return trimmed.substring(comma + 1);
        }
        return trimmed;
    }
}
