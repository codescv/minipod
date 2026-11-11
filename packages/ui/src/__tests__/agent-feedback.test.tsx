import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRouteStore } from '../app/routes';
import {
  AGENT_FEEDBACK_EMAIL_KEY,
  AGENT_FEEDBACK_EMAIL_PLACEHOLDER,
  AGENT_FEEDBACK_MAX_IMAGE_BYTES,
  buildAgentFeedbackBody,
  buildAgentFeedbackEmail,
  buildAgentFeedbackMailto,
  buildAgentFeedbackSubject,
  extractFeedbackSummary,
  isValidFeedbackEmail,
  loadAgentFeedbackEmail,
  readAgentFeedbackImage,
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

/** Version-independent fixture for pure builder tests (not rewritten by `scripts/bump-version.mjs`). */
const FIXTURE_VERSION = '0.1.20';
const FIXTURE_TAG = `minipod: [v${FIXTURE_VERSION}]`;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_BASE64 = 'iVBORw==';

describe('Agent Feedback Email & One-Click Mailto Builder (v0.1.20)', () => {
  it('validates email addresses and builds versioned mailto URIs with encoded subject and body', () => {
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
      appVersion: FIXTURE_VERSION,
      feedbackText: '章节跳转按钮偶发错位\n复现步骤：打开长音频节目并展开章节面板',
    });
    expect(subject).toBe(`${FIXTURE_TAG} 章节跳转按钮偶发错位`);

    const body = buildAgentFeedbackBody({
      feedbackText: '章节跳转按钮偶发错位\n复现步骤：打开长音频节目并展开章节面板',
      appVersion: FIXTURE_VERSION,
      platform: 'android',
      os: 'Android 15',
    });
    expect(body).toContain(`App: Podcasts (minipod) v${FIXTURE_VERSION}`);
    expect(body).toContain('Platform: android (Android 15)');

    const mailto = buildAgentFeedbackMailto({
      email: '  agent@example.com ',
      appVersion: FIXTURE_VERSION,
      feedbackText: '章节跳转按钮偶发错位\n复现步骤：打开长音频节目并展开章节面板',
      platform: 'android',
      os: 'Android 15',
    });

    expect(mailto.startsWith('mailto:agent@example.com?subject=')).toBe(true);
    const parsed = new URL(mailto);
    expect(parsed.protocol).toBe('mailto:');
    expect(parsed.pathname).toBe('agent@example.com');
    expect(parsed.searchParams.get('subject')).toBe(`${FIXTURE_TAG} 章节跳转按钮偶发错位`);
    expect(parsed.searchParams.get('body')).toBe(body);

    expect(() =>
      buildAgentFeedbackMailto({
        email: 'not-an-email',
        appVersion: FIXTURE_VERSION,
        feedbackText: 'Test',
      }),
    ).toThrow(/Invalid Agent feedback email/i);
  });

  it('uses the explicit 标题 (Title) as subject summary and lists Attachment: <filename> in the body (v0.1.23)', () => {
    expect(
      buildAgentFeedbackSubject({
        appVersion: FIXTURE_VERSION,
        summary: '  播放页   进度条拖动卡顿 ',
        feedbackText: '第一行描述\n第二行',
      }),
    ).toBe(`${FIXTURE_TAG} 播放页 进度条拖动卡顿`);
    // Blank title falls back to the first non-empty description line.
    expect(
      buildAgentFeedbackSubject({ appVersion: FIXTURE_VERSION, summary: '   ', feedbackText: '\n第一行描述\n第二行' }),
    ).toBe(`${FIXTURE_TAG} 第一行描述`);

    const email = buildAgentFeedbackEmail({
      email: ' agent@example.com ',
      appVersion: FIXTURE_VERSION,
      summary: 'Seek bar stutters',
      feedbackText: 'Dragging the seek bar on the expanded player stutters.',
      platform: 'android',
      os: 'Android 15',
      attachmentName: 'seek-bar.png',
    });
    expect(email.to).toBe('agent@example.com');
    expect(email.subject).toBe(`${FIXTURE_TAG} Seek bar stutters`);
    expect(email.body).toBe(
      [
        'Dragging the seek bar on the expanded player stutters.',
        '',
        '---',
        `App: Podcasts (minipod) v${FIXTURE_VERSION}`,
        'Platform: android (Android 15)',
        'Attachment: seek-bar.png',
      ].join('\n'),
    );
    const parsed = new URL(email.mailtoUrl);
    expect(parsed.searchParams.get('subject')).toBe(email.subject);
    expect(parsed.searchParams.get('body')).toBe(email.body);

    const noAttachment = buildAgentFeedbackBody({ feedbackText: 'x', appVersion: FIXTURE_VERSION });
    expect(noAttachment).not.toContain('Attachment:');
  });

  it('reads 增加图片 (Add image) files into name / mimeType / Base64 and rejects non-images or oversized files', async () => {
    const image = await readAgentFeedbackImage(new File([PNG_BYTES], 'shot.png', { type: 'image/png' }));
    expect(image).toEqual({ name: 'shot.png', mimeType: 'image/png', base64: PNG_BASE64 });

    await expect(
      readAgentFeedbackImage(new File(['hello'], 'notes.txt', { type: 'text/plain' })),
    ).rejects.toThrow(/Unsupported/);

    const huge = new File([PNG_BYTES], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: AGENT_FEEDBACK_MAX_IMAGE_BYTES + 1 });
    await expect(readAgentFeedbackImage(huge)).rejects.toThrow(/too large/);
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
    expect(screen.getByTestId('settings-version-badge')).toHaveTextContent('v0.1.33');

    const feedbackBtn = screen.getByTestId('settings-feedback-btn');
    expect(feedbackBtn).toHaveTextContent('反馈给 Agent');

    // Clicking the inline Row 8 feedback trigger opens Feedback Dialog without opening About Dialog
    fireEvent.click(feedbackBtn);
    expect(screen.queryByTestId('settings-about-dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('settings-feedback-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('settings-feedback-subject-preview')).toHaveTextContent(
      'minipod: [v0.1.33]',
    );

    const emailInput = screen.getByTestId('settings-feedback-email-input') as HTMLInputElement;
    expect(emailInput.placeholder).toBe(AGENT_FEEDBACK_EMAIL_PLACEHOLDER);

    // v0.1.23: 标题 / 问题描述 / 增加图片 fields inside the single feedback dialog
    const zhDialog = screen.getByTestId('settings-feedback-dialog');
    expect(zhDialog).toHaveTextContent('标题');
    expect(zhDialog).toHaveTextContent('问题描述');
    expect(screen.getByTestId('settings-feedback-title-input')).toHaveAttribute('type', 'text');
    expect(screen.getByTestId('settings-feedback-message-input').tagName).toBe('TEXTAREA');
    const imageInput = screen.getByTestId('settings-feedback-image-input') as HTMLInputElement;
    expect(imageInput).toHaveAttribute('type', 'file');
    expect(imageInput).toHaveAttribute('accept', 'image/*');
    expect(screen.getByTestId('settings-feedback-add-image-btn')).toHaveTextContent('增加图片');
    expect(screen.queryByTestId('settings-feedback-image-name')).not.toBeInTheDocument();

    // Save Agent Feedback Email locally
    fireEvent.change(emailInput, { target: { value: 'agent@example.com' } });
    fireEvent.click(screen.getByTestId('settings-feedback-save-email-btn'));
    expect(localStorage.getItem(AGENT_FEEDBACK_EMAIL_KEY)).toBe('agent@example.com');

    // Close and remount in English to verify localStorage persistence across sessions
    firstRender.unmount();
    useRouteStore.getState().reset();

    const { host } = renderMiniPod({ width: 390 });
    expect(host.sentFeedbackEmails).toHaveLength(0);
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

    expect(screen.getByTestId('settings-feedback-dialog')).toHaveTextContent('Title');
    expect(screen.getByTestId('settings-feedback-dialog')).toHaveTextContent('Issue description');
    expect(screen.getByTestId('settings-feedback-add-image-btn')).toHaveTextContent('Add image');

    // Blank title → subject falls back to the first description line; no image → plain mailto:
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
      'minipod: [v0.1.33] Support chapter artwork zoom',
    );
    expect(parsed.searchParams.get('body')).toContain(
      'Support chapter artwork zoom\nTap cover inside chapter list',
    );
    expect(parsed.searchParams.get('body')).toContain('App: Podcasts (minipod) v0.1.33');
    expect(parsed.searchParams.get('body')).not.toContain('Attachment:');
    expect(host.sentFeedbackEmails).toHaveLength(0);
    await waitFor(() => {
      expect(screen.queryByTestId('settings-feedback-dialog')).not.toBeInTheDocument();
    });
  });

  it('sends 标题 + 问题描述 + 增加图片 through host.files.sendFeedbackEmail with the image attachment (v0.1.23)', async () => {
    localStorage.setItem(AGENT_FEEDBACK_EMAIL_KEY, 'agent@example.com');
    const { host } = renderMiniPod({
      width: 1024,
      hostOptions: { initialSettings: { uiLanguage: 'zh-CN' } },
    });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-settings'));
    await screen.findByTestId('settings-screen');

    // The About dialog no longer carries a duplicate feedback button.
    fireEvent.click(screen.getByTestId('settings-row-about'));
    expect(await screen.findByTestId('settings-about-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-about-feedback-btn')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('settings-about-dialog')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('settings-feedback-btn')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('settings-feedback-btn'));
    await screen.findByTestId('settings-feedback-dialog');
    expect((screen.getByTestId('settings-feedback-email-input') as HTMLInputElement).value).toBe(
      'agent@example.com',
    );

    fireEvent.change(screen.getByTestId('settings-feedback-title-input'), {
      target: { value: '播放页进度条拖动卡顿' },
    });
    fireEvent.change(screen.getByTestId('settings-feedback-message-input'), {
      target: { value: '复现步骤：\n1. 打开展开播放器\n2. 快速拖动进度条' },
    });

    const imageInput = screen.getByTestId('settings-feedback-image-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(imageInput, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByTestId('settings-feedback-add-image-btn'));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Pick → chip shows filename, button flips to 更换图片, remove clears it
    await act(async () => {
      fireEvent.change(imageInput, {
        target: { files: [new File([PNG_BYTES], 'first.png', { type: 'image/png' })] },
      });
    });
    expect(await screen.findByTestId('settings-feedback-image-name')).toHaveTextContent('first.png');
    expect(screen.getByTestId('settings-feedback-add-image-btn')).toHaveTextContent('更换图片');
    fireEvent.click(screen.getByTestId('settings-feedback-remove-image-btn'));
    expect(screen.queryByTestId('settings-feedback-image-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-feedback-add-image-btn')).toHaveTextContent('增加图片');

    await act(async () => {
      fireEvent.change(imageInput, {
        target: { files: [new File([PNG_BYTES], 'seek-bar.png', { type: 'image/png' })] },
      });
    });
    expect(await screen.findByTestId('settings-feedback-image-name')).toHaveTextContent('seek-bar.png');

    fireEvent.click(screen.getByTestId('settings-feedback-send-btn'));
    await waitFor(() => {
      expect(host.sentFeedbackEmails).toHaveLength(1);
    });
    expect(host.openedExternalUrls).toHaveLength(0);

    const sent = host.sentFeedbackEmails[0]!;
    expect(sent.to).toBe('agent@example.com');
    expect(sent.subject).toBe('minipod: [v0.1.33] 播放页进度条拖动卡顿');
    expect(sent.body).toContain('复现步骤：\n1. 打开展开播放器\n2. 快速拖动进度条');
    expect(sent.body).toContain('App: Podcasts (minipod) v0.1.33');
    expect(sent.body).toContain('Attachment: seek-bar.png');
    expect(sent.attachment).toEqual({ name: 'seek-bar.png', mimeType: 'image/png', base64: PNG_BASE64 });
    const fallback = new URL(sent.mailtoUrl);
    expect(fallback.searchParams.get('subject')).toBe(sent.subject);
    expect(fallback.searchParams.get('body')).toBe(sent.body);

    // Draft (title / description / image) is reset after sending.
    await waitFor(() => {
      expect(screen.queryByTestId('settings-feedback-dialog')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('settings-feedback-btn'));
    await screen.findByTestId('settings-feedback-dialog');
    expect((screen.getByTestId('settings-feedback-title-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('settings-feedback-message-input') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('settings-feedback-image-name')).not.toBeInTheDocument();
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
