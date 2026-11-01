import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRouteStore } from '../app/routes';
import {
  AGENT_FEEDBACK_EMAIL_KEY,
  AGENT_FEEDBACK_EMAIL_PLACEHOLDER,
  buildAgentFeedbackBody,
  buildAgentFeedbackMailto,
  buildAgentFeedbackSubject,
  extractFeedbackSummary,
  isValidFeedbackEmail,
  loadAgentFeedbackEmail,
  saveAgentFeedbackEmail,
} from '../features/settings/agent-feedback';
import { renderMiniPod } from './test-helpers';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.gradle', '.git']);
const BINARY_EXT_RE = /\.(?:png|jpg|jpeg|webp|gif|ico|keystore|jar|apk|bin|mp3|ogg|m4a|mp4|woff2?)$/i;

function collectPackageFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      collectPackageFiles(fullPath, acc);
    } else if (st.isFile() && !BINARY_EXT_RE.test(entry)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

describe('Agent Feedback Email & One-Click Mailto Builder (v0.1.20)', () => {
  it('validates email addresses and builds minipod: [v0.1.20] mailto URIs with encoded subject and body', () => {
    expect(isValidFeedbackEmail('agent@example.com')).toBe(true);
    expect(isValidFeedbackEmail('  vibe.bot+pod@sub.example.org  ')).toBe(true);
    expect(isValidFeedbackEmail('')).toBe(false);
    expect(isValidFeedbackEmail('invalid-email')).toBe(false);
    expect(isValidFeedbackEmail('missing-domain@localhost')).toBe(false);

    expect(extractFeedbackSummary('\n  Queue auto-scroll jumps on drag\nSecond line details  ')).toBe(
      'Queue auto-scroll jumps on drag',
    );
    expect(extractFeedbackSummary('')).toBe('Feedback');

    const subject = buildAgentFeedbackSubject({
      appVersion: '0.1.20',
      feedbackText: '章节跳转按钮偶发错位\n复现步骤：打开长音频节目并展开章节面板',
    });
    expect(subject).toBe('minipod: [v0.1.20] 章节跳转按钮偶发错位');

    const body = buildAgentFeedbackBody({
      feedbackText: '章节跳转按钮偶发错位\n复现步骤：打开长音频节目并展开章节面板',
      appVersion: '0.1.20',
      platform: 'android',
      os: 'Android 15',
    });
    expect(body).toContain('App: Podcasts (minipod) v0.1.20');
    expect(body).toContain('Platform: android (Android 15)');

    const mailto = buildAgentFeedbackMailto({
      email: '  agent@example.com ',
      appVersion: '0.1.20',
      feedbackText: '章节跳转按钮偶发错位\n复现步骤：打开长音频节目并展开章节面板',
      platform: 'android',
      os: 'Android 15',
    });

    expect(mailto.startsWith('mailto:agent@example.com?subject=')).toBe(true);
    const parsed = new URL(mailto);
    expect(parsed.protocol).toBe('mailto:');
    expect(parsed.pathname).toBe('agent@example.com');
    expect(parsed.searchParams.get('subject')).toBe('minipod: [v0.1.20] 章节跳转按钮偶发错位');
    expect(parsed.searchParams.get('body')).toBe(body);

    expect(() =>
      buildAgentFeedbackMailto({
        email: 'not-an-email',
        appVersion: '0.1.20',
        feedbackText: 'Test',
      }),
    ).toThrow(/Invalid Agent feedback email/i);
  });

  it('persists and clears Agent Feedback Email strictly in localStorage', () => {
    expect(loadAgentFeedbackEmail()).toBe('');

    const saved = saveAgentFeedbackEmail('  agent@example.com  ');
    expect(saved).toBe('agent@example.com');
    expect(localStorage.getItem(AGENT_FEEDBACK_EMAIL_KEY)).toBe('agent@example.com');
    expect(loadAgentFeedbackEmail()).toBe('agent@example.com');

    saveAgentFeedbackEmail('   ');
    expect(localStorage.getItem(AGENT_FEEDBACK_EMAIL_KEY)).toBeNull();
    expect(loadAgentFeedbackEmail()).toBe('');
  });

  it('preserves the strict 8-row SettingsPage invariant and launches mailto: from Row 8 in zh-CN and en', async () => {
    const firstRender = renderMiniPod({
      width: 1024,
      hostOptions: {
        initialSettings: { uiLanguage: 'zh-CN' },
      },
    });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-settings'));

    const settingsScreen = await screen.findByTestId('settings-screen');
    expect(settingsScreen.querySelectorAll('[data-settings-row]')).toHaveLength(8);
    expect(settingsScreen.querySelectorAll('.m-settings-row')).toHaveLength(8);
    expect(screen.getByTestId('settings-version-badge')).toHaveTextContent('v0.1.22');

    const feedbackBtn = screen.getByTestId('settings-feedback-btn');
    expect(feedbackBtn).toHaveTextContent('反馈给 Agent');

    // Clicking the inline Row 8 feedback trigger opens Feedback Dialog without opening About Dialog
    fireEvent.click(feedbackBtn);
    expect(screen.queryByTestId('settings-about-dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('settings-feedback-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('settings-feedback-subject-preview')).toHaveTextContent(
      'minipod: [v0.1.22]',
    );

    const emailInput = screen.getByTestId('settings-feedback-email-input') as HTMLInputElement;
    expect(emailInput.placeholder).toBe(AGENT_FEEDBACK_EMAIL_PLACEHOLDER);

    // Save Agent Feedback Email locally
    fireEvent.change(emailInput, { target: { value: 'agent@example.com' } });
    fireEvent.click(screen.getByTestId('settings-feedback-save-email-btn'));
    expect(localStorage.getItem(AGENT_FEEDBACK_EMAIL_KEY)).toBe('agent@example.com');

    // Close and remount in English to verify localStorage persistence across sessions
    firstRender.unmount();
    useRouteStore.getState().reset();

    const { host } = renderMiniPod({ width: 390 });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('subs-settings-btn'));
    const mobileSettings = await screen.findByTestId('settings-screen');
    expect(mobileSettings.querySelectorAll('[data-settings-row]')).toHaveLength(8);
    expect(mobileSettings.querySelectorAll('.m-settings-row')).toHaveLength(8);

    const enFeedbackBtn = screen.getByTestId('settings-feedback-btn');
    expect(enFeedbackBtn).toHaveTextContent('Send Feedback to Agent');
    fireEvent.click(enFeedbackBtn);

    const persistedEmailInput = (await screen.findByTestId(
      'settings-feedback-email-input',
    )) as HTMLInputElement;
    expect(persistedEmailInput.value).toBe('agent@example.com');

    fireEvent.change(screen.getByTestId('settings-feedback-message-input'), {
      target: { value: 'Support chapter artwork zoom\nTap cover inside chapter list' },
    });
    fireEvent.click(screen.getByTestId('settings-feedback-send-btn'));

    await waitFor(() => {
      expect(host.openedExternalUrls).toHaveLength(1);
    });

    const launchedUrl = host.openedExternalUrls[0]!;
    expect(launchedUrl.startsWith('mailto:agent@example.com?subject=')).toBe(true);
    const parsed = new URL(launchedUrl);
    expect(parsed.searchParams.get('subject')).toBe(
      'minipod: [v0.1.22] Support chapter artwork zoom',
    );
    expect(parsed.searchParams.get('body')).toContain(
      'Support chapter artwork zoom\nTap cover inside chapter list',
    );
    expect(parsed.searchParams.get('body')).toContain('App: Podcasts (minipod) v0.1.22');
  });

  it('contains zero corporate or personal email leakage anywhere in packages/', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packagesRoot = resolve(here, '../../../');
    const files = collectPackageFiles(packagesRoot);
    expect(files.length).toBeGreaterThan(20);

    const forbiddenEmailDomain = `${String.fromCharCode(64)}${['goo', 'gle'].join('')}.com`;
    const violations: string[] = [];

    for (const filePath of files) {
      const text = readFileSync(filePath, 'utf8').toLowerCase();
      if (text.includes(forbiddenEmailDomain)) {
        violations.push(filePath);
      }
    }

    expect(violations).toEqual([]);
  });
});
