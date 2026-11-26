import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ChatInput from './ChatInput';
import { ComposerModelPicker } from './ComposerModelPicker';
import { TooltipProvider } from '../ui/tooltip';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { loadLocaleMessages } from '../../application/i18n/messages';
import {
  buildRemoteDesktopScreenshotFilename,
  createRemoteDesktopScreenshotFile,
  createRemoteDesktopUploadedFile,
  dispatchAddRemoteScreenToAI,
  isRemoteDesktopScreenshotFile,
  subscribeAddRemoteScreenToAI,
} from './remoteDesktopAiDraft';
import {
  computeSnipSelectionRect,
  RemoteDesktopSnipOverlay,
} from '../remoteDesktop/RemoteDesktopSnipOverlay';

before(async () => {
  for (const locale of ['zh-CN', 'zh-TW', 'es', 'ru']) await loadLocaleMessages(locale);
});

test('ChatInput allows image-only submission, shows quick prompt chips for remote desktop screenshots, and renders non-blocking vision warning for text-only models', () => {
  const uploaded = createRemoteDesktopUploadedFile({
    sessionId: 'rdp-1',
    protocol: 'rdp',
    base64Data: 'QUJDRA==',
    mediaType: 'image/png',
    width: 480,
    height: 210,
    crop: { x: 100, y: 100, width: 250, height: 200 },
  }, 'rd-img-1');

  assert.equal(isRemoteDesktopScreenshotFile(uploaded), true);
  assert.equal(uploaded.filename, 'remote-screen-rdp-snip-480x210.png');

  const html = renderToStaticMarkup(
    <I18nProvider locale="zh-CN">
      <TooltipProvider>
        <ChatInput
          value=""
          onChange={() => {}}
          onSend={() => {}}
          agentName="Catty Agent"
          files={[uploaded]}
          providerSwitcher={{
            providers: [{
              id: 'p-ds',
              providerId: 'deepseek',
              name: 'DeepSeek',
              defaultModel: 'deepseek-reasoner',
              enabled: true,
            }],
            selectedProviderId: 'p-ds',
            selectedModelId: 'deepseek-reasoner',
            onSelect: () => {},
          }}
        />
      </TooltipProvider>
    </I18nProvider>,
  );

  assert.match(html, /data-allow-empty-submit="true"/);
  assert.match(html, /data-testid="ai-vision-model-warning"/);
  assert.match(html, /deepseek-reasoner/);
  assert.match(html, /切换模型/);
  assert.match(html, /data-testid="ai-remote-screen-quick-prompts"/);
  assert.match(html, /解释当前报错/);
  assert.match(html, /诊断界面问题/);
  assert.match(html, /总结屏幕内容/);
});

test('ChatInput hides vision warning banner for vision-capable and unknown custom models', () => {
  const visionHtml = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isRemoteDesktopContext
        providerSwitcher={{
          providers: [{
            id: 'p-anth',
            providerId: 'anthropic',
            name: 'Anthropic',
            defaultModel: 'claude-sonnet-4-20250514',
            enabled: true,
          }],
          selectedProviderId: 'p-anth',
          selectedModelId: 'claude-sonnet-4-20250514',
          onSelect: () => {},
        }}
      />
    </TooltipProvider>,
  );
  assert.doesNotMatch(visionHtml, /ai-vision-model-warning/);

  const unknownHtml = renderToStaticMarkup(
    <TooltipProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        isRemoteDesktopContext
        providerSwitcher={{
          providers: [{
            id: 'p-custom',
            providerId: 'custom',
            name: 'Custom Relay',
            defaultModel: 'internal-company-model-v3',
            enabled: true,
          }],
          selectedProviderId: 'p-custom',
          selectedModelId: 'internal-company-model-v3',
          onSelect: () => {},
        }}
      />
    </TooltipProvider>,
  );
  assert.doesNotMatch(unknownHtml, /ai-vision-model-warning/);
});

test('ComposerModelPicker displays vision indicator badges only for vision-capable models', () => {
  const html = renderToStaticMarkup(
    <ComposerModelPicker
      modelPresets={[
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]}
      selectedModelId="gpt-4o"
      prefs={{ recent: [], pinned: [] }}
      onSelectModel={() => {}}
      onTogglePinned={() => {}}
    />,
  );

  const matches = html.match(/data-vision-capable="true"/g) ?? [];
  assert.equal(matches.length, 1);
});

test('remoteDesktopAiDraft builds File payloads and dispatches to subscribers', () => {
  const file = createRemoteDesktopScreenshotFile({
    sessionId: 'vnc-1',
    protocol: 'vnc',
    base64Data: 'data:image/jpeg;base64,QUJDRA==',
    mediaType: 'image/jpeg',
    width: 1280,
    height: 720,
  });
  assert.equal(file.name, 'remote-screen-vnc-full-1280x720.jpg');
  assert.equal(file.type, 'image/jpeg');
  assert.equal(file.size, 4);
  assert.equal(
    buildRemoteDesktopScreenshotFilename({ mediaType: 'image/png', protocol: 'rdp', crop: { x: 0, y: 0, width: 100, height: 100 } }),
    'remote-screen-rdp-snip.png',
  );

  const received: string[] = [];
  const unsub = subscribeAddRemoteScreenToAI((payload) => received.push(payload.sessionId));
  dispatchAddRemoteScreenToAI({
    sessionId: 'vnc-1',
    base64Data: 'QUJDRA==',
    mediaType: 'image/jpeg',
  });
  unsub();
  assert.deepEqual(received, ['vnc-1']);
});

test('RemoteDesktopSnipOverlay computes normalized 0..1000 crop coordinates across letterboxed canvas rects and renders overlay UI', () => {
  // Overlay is 1000x800, while letterboxed canvas is centered at left=100, top=100, 800x600.
  const overlayRect = { left: 0, top: 0, width: 1000, height: 800 };
  const canvasRect = { left: 100, top: 100, width: 800, height: 600 };

  // Reverse drag (bottom-right to top-left), slightly outside left edge (clamped to canvas left=100).
  const computed = computeSnipSelectionRect(
    { x: 500, y: 400 },
    { x: 50, y: 250 },
    overlayRect,
    canvasRect,
    1920,
    1080,
  );
  assert.ok(computed);
  assert.deepEqual(computed.displayRect, { left: 100, top: 250, width: 400, height: 150 });
  assert.deepEqual(computed.normalizedRect, {
    x: 0,
    y: 250,
    width: 500,
    height: 250,
    pixelWidth: 960,
    pixelHeight: 270,
  });

  // Tiny accidental click (< MIN_SNIP_DRAG_PX) returns null.
  assert.equal(
    computeSnipSelectionRect({ x: 200, y: 200 }, { x: 203, y: 204 }, overlayRect, canvasRect, 1920, 1080),
    null,
  );

  const closedHtml = renderToStaticMarkup(
    <RemoteDesktopSnipOverlay
      open={false}
      naturalWidth={1920}
      naturalHeight={1080}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.equal(closedHtml, '');

  const openHtml = renderToStaticMarkup(
    <I18nProvider locale="en">
      <RemoteDesktopSnipOverlay
        open
        naturalWidth={1920}
        naturalHeight={1080}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </I18nProvider>,
  );
  assert.match(openHtml, /data-testid="remote-desktop-snip-overlay"/);
  assert.match(openHtml, /Drag to select a region/);
  assert.match(openHtml, /Cancel region snip/);
});

test('AIChatSidePanel and AIChatPanelContent wire image-only send, quick prompts with draft attachments, and VNC/RDP host protocol', () => {
  const sidePanelSrc = readFileSync(new URL('../AIChatSidePanel.tsx', import.meta.url), 'utf8');
  const panelContentSrc = readFileSync(new URL('../AIChatPanelContent.tsx', import.meta.url), 'utf8');

  // 1. Image-only submit guard + filename fallback title
  assert.match(sidePanelSrc, /const hasImageAttachments = attachments\.some\(\(attachment\) => attachment\.mediaType\.startsWith\('image\/'\)\);/);
  assert.match(sidePanelSrc, /if \(\(!trimmed && !hasInlineTextAttachments && !hasImageAttachments\) \|\| isStreaming\) return;/);
  assert.match(sidePanelSrc, /const titleText = trimmed \|\| noteOnlyTitle\.trim\(\) \|\| imageOnlyTitle\.trim\(\);/);

  // 2. Quick prompt chips preserve & clear draft attachments via includeDraftAttachments
  assert.match(sidePanelSrc, /includeDraftAttachments:\s*true/);
  assert.match(sidePanelSrc, /handleSendQuickPrompt=\{handleSendQuickPrompt\}/);
  assert.match(panelContentSrc, /onSendQuickPrompt=\{handleSendQuickPrompt\}/);

  // 3. mentionHosts forwards session protocol so amber vision banner shows on VNC/RDP tabs before screenshot attach
  assert.match(panelContentSrc, /protocol:\s*session\.protocol/);
});
