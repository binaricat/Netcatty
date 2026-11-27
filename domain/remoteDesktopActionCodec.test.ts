import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findHighRiskRemoteDesktopActions,
  findHighRiskRemoteDesktopActionsFromInput,
  isHighRiskRemoteDesktopAction,
  looksLikeRemoteDesktopSecret,
  MAX_REMOTE_DESKTOP_ACTIONS_PER_CALL,
  MAX_REMOTE_DESKTOP_TYPE_TEXT_LENGTH,
  MAX_REMOTE_DESKTOP_WAIT_MS,
  MIN_REMOTE_DESKTOP_WAIT_MS,
  parseKeyChord,
  permilleToFramebufferCoord,
  resolveChordToRdpScancodes,
  resolveChordToVncKeysyms,
  resolveKeyToRdpScancode,
  resolveKeyToVncKeysym,
  sanitizeRemoteDesktopActionsForAudit,
  summarizeRemoteDesktopActions,
  validateAndNormalizeRemoteDesktopActions,
} from './remoteDesktopActionCodec';

describe('remoteDesktopActionCodec', () => {
  it('validates and normalizes all supported action types from JSON string or array', () => {
    const payload = JSON.stringify([
      { type: 'click', x: 480.4, y: 612.6, button: 'right', clickCount: 2, modifiers: ['shift', 'ctrl', 'ctrl'] },
      { type: 'move', x: 100, y: 200 },
      { type: 'drag', fromX: 10, fromY: 20, toX: 300, toY: 400, steps: 99 },
      { type: 'scroll', x: 500, y: 500, deltaY: -120 },
      { type: 'type', text: 'ipconfig' },
      { type: 'key', key: 'ctrl+shift+esc' },
      { type: 'wait', ms: 10 },
      { type: 'wait', ms: 99999 },
    ]);

    const res = validateAndNormalizeRemoteDesktopActions(payload);
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(res.actions.length, 8);
    assert.deepEqual(res.actions[0], {
      type: 'click',
      x: 480,
      y: 613,
      button: 'right',
      clickCount: 2,
      modifiers: ['ctrl', 'shift'],
    });
    assert.deepEqual(res.actions[1], { type: 'move', x: 100, y: 200 });
    assert.deepEqual(res.actions[2], {
      type: 'drag',
      fromX: 10,
      fromY: 20,
      toX: 300,
      toY: 400,
      button: 'left',
      steps: 40,
    });
    assert.deepEqual(res.actions[3], { type: 'scroll', x: 500, y: 500, deltaX: 0, deltaY: -120 });
    assert.deepEqual(res.actions[4], { type: 'type', text: 'ipconfig' });
    assert.deepEqual(res.actions[5], { type: 'key', key: 'Ctrl+Shift+Escape' });
    assert.deepEqual(res.actions[6], { type: 'wait', ms: MIN_REMOTE_DESKTOP_WAIT_MS });
    assert.deepEqual(res.actions[7], { type: 'wait', ms: MAX_REMOTE_DESKTOP_WAIT_MS });
  });

  it('rejects empty, oversized, out-of-range, and malformed payloads with clear errors', () => {
    assert.equal(validateAndNormalizeRemoteDesktopActions([]).ok, false);
    assert.equal(validateAndNormalizeRemoteDesktopActions('{not-json').ok, false);
    assert.equal(validateAndNormalizeRemoteDesktopActions({}).ok, false);

    const thirteen = Array.from({ length: MAX_REMOTE_DESKTOP_ACTIONS_PER_CALL + 1 }, () => ({
      type: 'wait',
      ms: 100,
    }));
    const tooMany = validateAndNormalizeRemoteDesktopActions(thirteen);
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.match(tooMany.error, /12/);

    const badCoord = validateAndNormalizeRemoteDesktopActions([{ type: 'click', x: 1200, y: 100 }]);
    assert.equal(badCoord.ok, false);
    if (!badCoord.ok) assert.match(badCoord.error, /0 and 1000/);

    const badScroll = validateAndNormalizeRemoteDesktopActions([{ type: 'scroll', x: 100, y: 100 }]);
    assert.equal(badScroll.ok, false);

    const longText = 'a'.repeat(MAX_REMOTE_DESKTOP_TYPE_TEXT_LENGTH + 1);
    const tooLong = validateAndNormalizeRemoteDesktopActions([{ type: 'type', text: longText }]);
    assert.equal(tooLong.ok, false);

    const unknownKey = validateAndNormalizeRemoteDesktopActions([{ type: 'key', key: 'HyperSuperMegaKey' }]);
    assert.equal(unknownKey.ok, false);

    const badClickCount = validateAndNormalizeRemoteDesktopActions([{ type: 'click', x: 10, y: 10, clickCount: 4 }]);
    assert.equal(badClickCount.ok, false);
  });

  it('parses key chords and resolves RDP scancodes and VNC keysyms accurately', () => {
    assert.deepEqual(parseKeyChord('Enter'), { modifiers: [], mainKey: 'Enter' });
    assert.deepEqual(parseKeyChord('Ctrl+C'), { modifiers: ['ctrl'], mainKey: 'c' });
    assert.deepEqual(parseKeyChord('Win+R'), { modifiers: ['meta'], mainKey: 'r' });
    assert.deepEqual(parseKeyChord('Shift+Ctrl+Esc'), { modifiers: ['ctrl', 'shift'], mainKey: 'Escape' });
    assert.deepEqual(parseKeyChord('Ctrl++'), { modifiers: ['ctrl'], mainKey: '+' });
    assert.deepEqual(parseKeyChord('Space'), { modifiers: [], mainKey: 'Space' });
    assert.equal(parseKeyChord('Ctrl+'), null);
    assert.equal(parseKeyChord('Unknown+A'), null);

    // RDP scancodes match rdpScancodeMap.ts
    assert.equal(resolveKeyToRdpScancode('Enter'), 0x001c);
    assert.equal(resolveKeyToRdpScancode('Escape'), 0x0001);
    assert.equal(resolveKeyToRdpScancode('Delete'), 0xe053);
    assert.equal(resolveKeyToRdpScancode('ArrowUp'), 0xe048);
    assert.equal(resolveKeyToRdpScancode('F4'), 0x003e);
    assert.equal(resolveKeyToRdpScancode('Meta'), 0xe05b);
    assert.deepEqual(resolveChordToRdpScancodes('Ctrl+Alt+Del'), [0x001d, 0x0038, 0xe053]);

    // VNC keysyms match vncKeymap.ts
    assert.equal(resolveKeyToVncKeysym('Enter'), 0xff0d);
    assert.equal(resolveKeyToVncKeysym('Escape'), 0xff1b);
    assert.equal(resolveKeyToVncKeysym('Delete'), 0xffff);
    assert.equal(resolveKeyToVncKeysym('ArrowLeft'), 0xff51);
    assert.equal(resolveKeyToVncKeysym('F12'), 0xffc9);
    assert.equal(resolveKeyToVncKeysym('Win'), 0xffeb);
    assert.equal(resolveKeyToVncKeysym('a'), 0x0061);
    assert.deepEqual(resolveChordToVncKeysyms('Ctrl+Alt+Del'), [0xffe3, 0xffe9, 0xffff]);
  });

  it('detects high-risk OS chords and spares benign chords', () => {
    const highRiskKeys = [
      'Ctrl+Alt+Del',
      'Alt+F4',
      'Win+R',
      'Win+L',
      'Ctrl+Shift+Esc',
      'Cmd+Q',
      'Ctrl+Alt+Backspace',
      'Ctrl+Alt+F2',
    ];
    for (const key of highRiskKeys) {
      assert.equal(
        isHighRiskRemoteDesktopAction({ type: 'key', key }),
        true,
        `${key} must be classified as high risk`,
      );
    }

    const benignKeys = ['Enter', 'Tab', 'Ctrl+C', 'Ctrl+V', 'Ctrl+S', 'Alt+Tab', 'F5'];
    for (const key of benignKeys) {
      assert.equal(
        isHighRiskRemoteDesktopAction({ type: 'key', key }),
        false,
        `${key} should not be classified as high risk`,
      );
    }

    const matches = findHighRiskRemoteDesktopActions([
      { type: 'click', x: 100, y: 100 },
      { type: 'key', key: 'Alt+F4' },
      { type: 'type', text: 'hello' },
      { type: 'key', key: 'Win+R' },
    ]);
    assert.equal(matches.length, 2);
    assert.equal(matches[0].index, 1);
    assert.equal(matches[0].chord, 'Alt+F4');
    assert.equal(matches[1].index, 3);
    assert.equal(matches[1].chord, 'Meta+R');

    const fromRaw = findHighRiskRemoteDesktopActionsFromInput({
      actions: JSON.stringify([{ type: 'key', key: 'ctrl+alt+del' }]),
    });
    assert.equal(fromRaw.length, 1);
    assert.equal(fromRaw[0].chord, 'Ctrl+Alt+Delete');
  });

  it('summarizes action batches clearly and redacts secret-like text by default', () => {
    const summary = summarizeRemoteDesktopActions([
      { type: 'click', x: 480, y: 612 },
      { type: 'type', text: 'ipconfig' },
      { type: 'key', key: 'Enter' },
    ]);
    assert.equal(summary, 'Click (480, 612) -> Type "ipconfig" -> Press Enter');

    const secretText = 'sk-live-9876543210abcdef';
    assert.equal(looksLikeRemoteDesktopSecret(secretText), true);
    assert.equal(looksLikeRemoteDesktopSecret('password=SuperSecret123!'), true);
    assert.equal(looksLikeRemoteDesktopSecret('ipconfig /all'), false);
    assert.equal(looksLikeRemoteDesktopSecret('https://example.com/status'), false);

    const redactedSummary = summarizeRemoteDesktopActions([
      { type: 'type', text: secretText },
    ]);
    assert.equal(redactedSummary, 'Type "[REDACTED]"');
    assert.doesNotMatch(redactedSummary, /sk-live/);

    const sanitized = sanitizeRemoteDesktopActionsForAudit([
      { type: 'type', text: secretText },
      { type: 'type', text: 'ls -la' },
    ]);
    assert.deepEqual(sanitized[0], { type: 'type', text: '[REDACTED]' });
    assert.deepEqual(sanitized[1], { type: 'type', text: 'ls -la' });
  });

  it('maps 0..1000 permille coordinates cleanly onto framebuffer pixel bounds', () => {
    assert.equal(permilleToFramebufferCoord(0, 1920), 0);
    assert.equal(permilleToFramebufferCoord(1000, 1920), 1919);
    assert.equal(permilleToFramebufferCoord(500, 1001), 500);
    assert.equal(permilleToFramebufferCoord(-50, 1920), 0);
    assert.equal(permilleToFramebufferCoord(1500, 1920), 1919);
  });
});
