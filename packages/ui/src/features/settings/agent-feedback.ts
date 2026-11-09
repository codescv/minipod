/**
 * Local-only Agent Feedback configuration (`localStorage`) and `mailto:` URI builder.
 *
 * Formats outgoing feedback emails with subject prefix `minipod: [v<version>] <summary>`
 * so Vibe Coding email dispatchers can route tasks directly to MiniPod.
 */

export const AGENT_FEEDBACK_EMAIL_KEY = 'minipod_agent_feedback_email';
export const AGENT_FEEDBACK_EMAIL_PLACEHOLDER = 'agent@example.com';
export const AGENT_FEEDBACK_PROJECT_ALIAS = 'minipod';

const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

export function isValidFeedbackEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254) return false;
  return EMAIL_PATTERN.test(trimmed);
}

export function loadAgentFeedbackEmail(storage?: Pick<Storage, 'getItem'>): string {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    return (store?.getItem(AGENT_FEEDBACK_EMAIL_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function saveAgentFeedbackEmail(
  email: string,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): string {
  const normalized = email.trim();
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    if (store) {
      if (normalized) {
        store.setItem(AGENT_FEEDBACK_EMAIL_KEY, normalized);
      } else {
        store.removeItem(AGENT_FEEDBACK_EMAIL_KEY);
      }
    }
  } catch {
    // Ignore storage access errors in restricted WebViews / private mode.
  }
  return normalized;
}

export function normalizeFeedbackVersion(appVersion: string): string {
  const cleaned = appVersion.trim().replace(/^v/i, '');
  return `v${cleaned || '0.1.31'}`;
}

export function extractFeedbackSummary(feedbackText: string, maxLength = 72): string {
  const firstLine =
    feedbackText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  if (!collapsed) return 'Feedback';
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…` : collapsed;
}

export interface AgentFeedbackSubjectOptions {
  readonly appVersion: string;
  readonly summary?: string | undefined;
  readonly feedbackText?: string | undefined;
}

export function buildAgentFeedbackSubject(options: AgentFeedbackSubjectOptions): string {
  const versionTag = normalizeFeedbackVersion(options.appVersion);
  const explicitSummary = options.summary?.trim().replace(/\s+/g, ' ');
  const resolvedSummary = explicitSummary || extractFeedbackSummary(options.feedbackText ?? '');
  return `${AGENT_FEEDBACK_PROJECT_ALIAS}: [${versionTag}] ${resolvedSummary}`;
}

export interface AgentFeedbackBodyOptions {
  readonly feedbackText: string;
  readonly appVersion: string;
  readonly platform?: string | undefined;
  readonly os?: string | undefined;
  /** Selected image attachment file name (v0.1.23), listed as `Attachment: <name>`. */
  readonly attachmentName?: string | undefined;
}

export function buildAgentFeedbackBody(options: AgentFeedbackBodyOptions): string {
  const versionTag = normalizeFeedbackVersion(options.appVersion);
  const trimmed = options.feedbackText.trim();
  const metaLines = [`App: Podcasts (${AGENT_FEEDBACK_PROJECT_ALIAS}) ${versionTag}`];
  if (options.platform) {
    metaLines.push(
      options.os ? `Platform: ${options.platform} (${options.os})` : `Platform: ${options.platform}`,
    );
  }
  const attachmentName = options.attachmentName?.trim();
  if (attachmentName) {
    metaLines.push(`Attachment: ${attachmentName}`);
  }
  const footer = `---\n${metaLines.join('\n')}`;
  return trimmed ? `${trimmed}\n\n${footer}` : `\n\n${footer}`;
}

export interface AgentFeedbackMailtoOptions {
  readonly email: string;
  readonly appVersion: string;
  readonly feedbackText: string;
  /** Explicit 标题 / Title; falls back to the first non-empty line of `feedbackText`. */
  readonly summary?: string | undefined;
  readonly platform?: string | undefined;
  readonly os?: string | undefined;
  readonly attachmentName?: string | undefined;
}

export interface AgentFeedbackEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly mailtoUrl: string;
}

/** Builds recipient, subject, body and the equivalent `mailto:` URI in one pass. */
export function buildAgentFeedbackEmail(options: AgentFeedbackMailtoOptions): AgentFeedbackEmail {
  const normalizedEmail = options.email.trim();
  if (!isValidFeedbackEmail(normalizedEmail)) {
    throw new Error('Invalid Agent feedback email address');
  }
  const subject = buildAgentFeedbackSubject({
    appVersion: options.appVersion,
    summary: options.summary,
    feedbackText: options.feedbackText,
  });
  const body = buildAgentFeedbackBody({
    feedbackText: options.feedbackText,
    appVersion: options.appVersion,
    platform: options.platform,
    os: options.os,
    attachmentName: options.attachmentName,
  });
  const mailtoUrl = `mailto:${normalizedEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { to: normalizedEmail, subject, body, mailtoUrl };
}

export function buildAgentFeedbackMailto(options: AgentFeedbackMailtoOptions): string {
  return buildAgentFeedbackEmail(options).mailtoUrl;
}

// ---------------------------------------------------------------------------
// v0.1.23 增加图片 / Add image attachment
// ---------------------------------------------------------------------------

export interface AgentFeedbackImage {
  readonly name: string;
  readonly mimeType: string;
  /** Raw Base64 payload without a `data:` prefix. */
  readonly base64: string;
}

/** Upper bound for attached images (Android Binder / Capacitor bridge payload safety). */
export const AGENT_FEEDBACK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function readBlobAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

/** Reads a picked image `File` into `{ name, mimeType, base64 }` (via `arrayBuffer` or `FileReader`). */
export async function readAgentFeedbackImage(file: File): Promise<AgentFeedbackImage> {
  const mimeType = file.type || 'image/*';
  if (!mimeType.startsWith('image/')) {
    throw new Error('Unsupported attachment type');
  }
  if (file.size > AGENT_FEEDBACK_MAX_IMAGE_BYTES) {
    throw new Error('Attachment too large');
  }
  let base64: string;
  if (typeof file.arrayBuffer === 'function') {
    base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  } else {
    const dataUrl = await readBlobAsDataUrl(file);
    const comma = dataUrl.indexOf(',');
    base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  }
  return { name: file.name || 'feedback_image', mimeType, base64 };
}
