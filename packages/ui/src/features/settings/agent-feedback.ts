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
  return `v${cleaned || '0.1.20'}`;
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
  const footer = `---\n${metaLines.join('\n')}`;
  return trimmed ? `${trimmed}\n\n${footer}` : `\n\n${footer}`;
}

export interface AgentFeedbackMailtoOptions {
  readonly email: string;
  readonly appVersion: string;
  readonly feedbackText: string;
  readonly summary?: string | undefined;
  readonly platform?: string | undefined;
  readonly os?: string | undefined;
}

export function buildAgentFeedbackMailto(options: AgentFeedbackMailtoOptions): string {
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
  });
  return `mailto:${normalizedEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
