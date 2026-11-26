import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { TooltipProvider } from '../ui/tooltip';
import { RemoteDesktopToolbar, type RemoteDesktopToolbarProps } from './RemoteDesktopToolbar';

function renderToolbar(overrides: Partial<RemoteDesktopToolbarProps> = {}): string {
  const baseProps: RemoteDesktopToolbarProps = {
    protocol: 'rdp',
    hostLabel: 'prod-win-01',
    status: 'connected',
    isFullscreen: false,
    keyboardGrabActive: false,
    onToggleKeyboardGrab: () => {},
    onSendSpecialKey: () => {},
    onTypeClipboard: () => {},
    displayMode: 'dynamic',
    onChangeDisplayMode: () => {},
    clipboardSyncEnabled: true,
    onToggleClipboardSync: () => {},
    quality: 'auto',
    onChangeQuality: () => {},
    viewOnly: false,
    onToggleViewOnly: () => {},
    onScreenshotCopy: () => {},
    onScreenshotSave: () => {},
    onToggleFullscreen: () => {},
    onReconnect: () => {},
    onDisconnect: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>
        <RemoteDesktopToolbar {...baseProps} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

test('RemoteDesktopToolbar renders SFTP button only when onOpenSftp is wired and highlights when open', () => {
  const withoutSftp = renderToolbar();
  assert.doesNotMatch(withoutSftp, /data-testid="remote-desktop-sftp-btn"/);

  const withSftpClosed = renderToolbar({ onOpenSftp: () => {}, isSftpOpen: false });
  assert.match(withSftpClosed, /data-testid="remote-desktop-sftp-btn"/);
  assert.match(withSftpClosed, /aria-pressed="false"/);

  const withSftpOpen = renderToolbar({ onOpenSftp: () => {}, isSftpOpen: true });
  assert.match(withSftpOpen, /aria-pressed="true"/);
});

test('RemoteDesktopToolbar renders live clipboard transfer progress pills for all phases', () => {
  const staged = renderToolbar({
    clipboardTransfer: {
      id: 't1',
      direction: 'upload',
      phase: 'staged',
      fileName: 'report.pdf',
      fileCount: 2,
      transferredBytes: 0,
      totalBytes: 2048,
      percent: 0,
      message: 'Ready to paste 2 files on remote (Ctrl+V)',
    },
  });
  assert.match(staged, /data-testid="rdp-clipboard-transfer-pill"/);
  assert.match(staged, /data-transfer-phase="staged"/);
  assert.match(staged, /2 file\(s\) · Ctrl\+V/);

  const transferring = renderToolbar({
    clipboardTransfer: {
      id: 't2',
      direction: 'download',
      phase: 'transferring',
      fileName: 'dump.log',
      fileCount: 1,
      transferredBytes: 512,
      totalBytes: 1024,
      percent: 50,
      message: 'Downloading dump.log (50%)',
    },
  });
  assert.match(transferring, /data-transfer-phase="transferring"/);
  assert.match(transferring, /dump\.log/);
  assert.match(transferring, /50%/);

  const completed = renderToolbar({
    clipboardTransfer: {
      id: 't3',
      direction: 'upload',
      phase: 'completed',
      fileName: 'a.txt',
      fileCount: 1,
      transferredBytes: 100,
      totalBytes: 100,
      percent: 100,
      message: 'Sent a.txt',
    },
    onDismissClipboardTransfer: () => {},
  });
  assert.match(completed, /data-transfer-phase="completed"/);
  assert.match(completed, /Dismiss transfer status/);
});

test('RemoteDesktopToolbar renders Ask AI split button, privacy lock badge, and recording pill (including fullscreen)', () => {
  const html = renderToolbar({
    isFullscreen: true,
    onAskAiFull: () => {},
    onAskAiRegion: () => {},
    onOpenAiChat: () => {},
    aiReadBlocked: true,
    onToggleAiReadBlocked: () => {},
    isRecording: true,
    recordingElapsedLabel: '02:14',
    onToggleRecording: () => {},
  });

  assert.match(html, /data-testid="remote-desktop-ask-ai-btn"/);
  assert.match(html, /data-testid="remote-desktop-ask-ai-menu"/);
  assert.match(html, /AI screen reading blocked/);
  assert.match(html, /data-testid="remote-desktop-record-btn"/);
  assert.match(html, /data-recording="true"/);
  assert.match(html, /02:14/);
});
