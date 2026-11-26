import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractRemoteDesktopPendingLabel,
  parseRemoteDesktopToolArtifact,
  resolveRemoteDesktopActionVisualKind,
} from './remoteDesktopToolArtifact.ts';
import { formatRemoteDesktopToolTooltip } from './formatRemoteDesktopToolTooltip.ts';

test('parseRemoteDesktopToolArtifact parses remote_desktop_read_screen payloads', () => {
  const artifact = parseRemoteDesktopToolArtifact('remote_desktop_read_screen', JSON.stringify({
    ok: true,
    captureId: 'rdcap-1',
    sessionId: 'rdp-1',
    protocol: 'rdp',
    hostLabel: 'Win11 Dev',
    hostname: '10.0.0.5',
    width: 1280,
    height: 720,
    naturalWidth: 1920,
    naturalHeight: 1080,
    grid: true,
  }));

  assert.deepEqual(artifact, {
    kind: 'remoteDesktop.screen',
    sessionId: 'rdp-1',
    captureId: 'rdcap-1',
    protocol: 'rdp',
    hostLabel: 'Win11 Dev',
    hostname: '10.0.0.5',
    width: 1280,
    height: 720,
    naturalWidth: 1920,
    naturalHeight: 1080,
    crop: undefined,
    grid: true,
  });
});

test('parseRemoteDesktopToolArtifact parses remote_desktop_act payloads and resolves visual kind', () => {
  const artifact = parseRemoteDesktopToolArtifact(
    'remote_desktop_act',
    JSON.stringify({
      ok: true,
      sessionId: 'vnc-1',
      protocol: 'vnc',
      hostLabel: 'Ubuntu Desktop',
      completedActions: 2,
      totalActions: 2,
      durationMs: 380,
      summary: 'Press Escape -> Drag (852, 500) -> (852, 700)',
      captureId: 'rdcap-2',
      width: 1280,
      height: 720,
    }),
    {
      actions: [
        { type: 'key', key: 'Escape' },
        { type: 'drag', fromX: 852, fromY: 500, toX: 852, toY: 700 },
      ],
    },
  );

  assert.equal(artifact?.kind, 'remoteDesktop.act');
  if (artifact?.kind === 'remoteDesktop.act') {
    assert.equal(artifact.summary, 'Press Escape → Drag (852, 500) → (852, 700)');
    assert.equal(artifact.actionVisualKind, 'mixed');
    assert.equal(artifact.durationMs, 380);
    assert.equal(artifact.completedActions, 2);
  }
});

test('parseRemoteDesktopToolArtifact turns plain string errors into error artifacts', () => {
  const artifact = parseRemoteDesktopToolArtifact(
    'remote_desktop_act',
    'Tool execution denied.',
    undefined,
    true,
  );

  assert.deepEqual(artifact, {
    kind: 'error',
    toolKind: 'act',
    message: 'Tool execution denied.',
  });
});

test('resolveRemoteDesktopActionVisualKind infers icon category from summary when args are absent', () => {
  assert.equal(resolveRemoteDesktopActionVisualKind(undefined, 'Click (120, 240)'), 'click');
  assert.equal(resolveRemoteDesktopActionVisualKind(undefined, 'Drag (10, 20) -> (30, 40)'), 'drag');
  assert.equal(resolveRemoteDesktopActionVisualKind(undefined, 'Scroll down (400, 300)'), 'scroll');
  assert.equal(resolveRemoteDesktopActionVisualKind(undefined, 'Type "hello" -> Press Enter'), 'keyboard');
  assert.equal(resolveRemoteDesktopActionVisualKind(undefined, 'Wait 500ms'), 'wait');
  assert.equal(resolveRemoteDesktopActionVisualKind(undefined, 'Click (10, 20) -> Wait 300ms'), 'click');
});

test('extractRemoteDesktopPendingLabel summarizes pending act and read_screen calls', () => {
  assert.deepEqual(
    extractRemoteDesktopPendingLabel('remote_desktop_act', {
      actions: [{ type: 'click', x: 500, y: 300 }],
    }),
    { kind: 'act', label: 'Click (500, 300)' },
  );
  assert.deepEqual(
    extractRemoteDesktopPendingLabel('remote_desktop_read_screen', {
      cropX: 100,
      cropY: 100,
      cropWidth: 300,
      cropHeight: 200,
      quality: 'high',
    }),
    { kind: 'screen', label: 'Read zoomed region · high' },
  );
});

test('formatRemoteDesktopToolTooltip redacts secret-like typed text in args', () => {
  const tooltip = formatRemoteDesktopToolTooltip(
    'remote_desktop_act',
    { actions: [{ type: 'type', text: 'ghp_1234567890abcdefghijklmnop' }] },
    { ok: true, summary: 'Type "[REDACTED]"' },
    false,
  );

  assert.doesNotMatch(tooltip, /ghp_1234567890/);
  assert.match(tooltip, /\[REDACTED\]/);
});
