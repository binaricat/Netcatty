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

test('RemoteDesktopToolbar does not expose SFTP button on graphical remote desktop toolbar', () => {
  const withoutSftp = renderToolbar();
  assert.doesNotMatch(withoutSftp, /data-testid="remote-desktop-sftp-btn"/);

  const withSftpProp = renderToolbar({ onOpenSftp: () => {}, isSftpOpen: true });
  assert.doesNotMatch(withSftpProp, /data-testid="remote-desktop-sftp-btn"/);
});

test('RemoteDesktopToolbar fullscreen wrapper passes clicks through except at the hover strip and visible pill', () => {
  const html = renderToolbar({ isFullscreen: true });
  const layers = html.match(/^<div class="([^"]+)"><div class="([^"]+)"><\/div><div class="([^"]+)">/);
  assert.ok(layers, 'fullscreen wrapper should contain the trigger strip and toolbar bar');
  const [, wrapperClass, triggerClass, barClass] = layers;

  assert.match(wrapperClass, /\bpointer-events-none\b/);
  assert.doesNotMatch(wrapperClass, /\bpointer-events-auto\b/);
  assert.match(wrapperClass, /\bleft-0 right-0\b/);
  assert.match(triggerClass, /\bpointer-events-auto\b/);
  assert.match(triggerClass, /\bh-3\b/);
  assert.match(barClass, /-translate-y-full opacity-0 pointer-events-none/);
  assert.doesNotMatch(barClass, /\bpointer-events-auto\b/);
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

test('RemoteDesktopToolbar renders monitor switcher, shared folders badge, and network quality pill', () => {
  const rdpHtml = renderToolbar({
    protocol: 'rdp',
    monitorCount: 2,
    activeMonitorIndex: 0,
    onSelectActiveMonitor: () => {},
    sharedFolders: [
      { id: 'sf-1', deviceId: 10, name: 'Projects', path: '/Users/dev/Projects', readOnly: false },
      { id: 'sf-2', deviceId: 11, name: 'Docs', path: '/Users/dev/Docs', readOnly: true },
    ],
    onAddSharedFolder: () => {},
    onRemoveSharedFolder: () => {},
    onToggleSharedFolderReadOnly: () => {},
    networkStats: {
      sessionId: 's1',
      protocol: 'rdp',
      rttMs: 18,
      rxBps: 128000,
      txBps: 4096,
      totalRxBytes: 2048000,
      totalTxBytes: 64000,
      ts: Date.now(),
    },
  });

  assert.match(rdpHtml, /data-testid="rdp-monitor-switcher"/);
  assert.match(rdpHtml, />All</);
  assert.match(rdpHtml, />1</);
  assert.match(rdpHtml, />2</);
  assert.match(rdpHtml, /data-testid="rdp-shared-folders-btn"/);
  assert.match(rdpHtml, />2</);
  assert.match(rdpHtml, /data-testid="remote-desktop-network-pill"/);
  assert.match(rdpHtml, /data-quality-tier="excellent"/);
  assert.match(rdpHtml, /18ms/);

  // VNC hides RDP-only monitor switcher & shared folders, keeps network quality pill
  const vncHtml = renderToolbar({
    protocol: 'vnc',
    monitorCount: 2,
    onSelectActiveMonitor: () => {},
    onAddSharedFolder: () => {},
    networkStats: {
      sessionId: 's2',
      protocol: 'vnc',
      rttMs: 245,
      rxBps: 50000,
      txBps: 1000,
      totalRxBytes: 500000,
      totalTxBytes: 10000,
      ts: Date.now(),
    },
  });
  assert.doesNotMatch(vncHtml, /data-testid="rdp-monitor-switcher"/);
  assert.doesNotMatch(vncHtml, /data-testid="rdp-shared-folders-btn"/);
  assert.match(vncHtml, /data-testid="remote-desktop-network-pill"/);
  assert.match(vncHtml, /data-quality-tier="poor"/);
  assert.match(vncHtml, /245ms/);
});

test('RemoteDesktopToolbar disables Keyboard Grab while connecting', () => {
  const connectingHtml = renderToolbar({
    protocol: 'vnc',
    status: 'connecting',
    viewOnly: false,
    keyboardGrabActive: false,
  });
  assert.match(connectingHtml, /<button[^>]*disabled=""[^>]*aria-label="Keys: Local"/);
});

test('RemoteDesktopToolbar renders Standard RDP security badge only when not using TLS', () => {
  const standardRdpHtml = renderToolbar({
    protocol: 'rdp',
    encrypted: false,
    legacySecurityBadge: 'RC4-128',
  });
  assert.match(standardRdpHtml, /RC4-128/);
  assert.match(standardRdpHtml, /Standard RDP Security \(RC4-128\)/);
  assert.doesNotMatch(standardRdpHtml, /Encrypted TLS connection/);

  const tlsHtml = renderToolbar({
    protocol: 'rdp',
    encrypted: true,
    legacySecurityBadge: 'RC4-128',
  });
  assert.match(tlsHtml, /Encrypted TLS connection/);
  assert.doesNotMatch(tlsHtml, /Standard RDP Security/);
});
