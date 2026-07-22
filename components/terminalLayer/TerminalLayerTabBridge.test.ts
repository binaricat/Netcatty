import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./TerminalLayerTabBridge.tsx', import.meta.url), 'utf8');

test('terminal layer bridge does not dock the shared host tree', () => {
  assert.doesNotMatch(source, /hostTreeDockedInLayer/);
});

test('terminal layer is visible only for terminal sessions or workspaces', () => {
  assert.match(source, /const isVisible = Boolean\(activeSession \|\| activeWorkspace \|\| s\.draggingSessionId\)/);
});

test('terminal panes can gate cwd restore per session host resolution', () => {
  const supportSource = readFileSync(new URL('./TerminalLayerSupport.tsx', import.meta.url), 'utf8');
  const layerSource = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');

  assert.match(supportSource, /sessionHostResolved: boolean/);
  assert.match(supportSource, /restoreTerminalCwd=\{restoreTerminalCwd && sessionHostResolved\}/);
  assert.match(layerSource, /session\.protocol === 'local'/);
});

test('terminal layer bridge refreshes when terminal settings change', () => {
  assert.match(source, /terminalSettings: s\.terminalSettings/);
  assert.match(source, /\[\s*[\s\S]*s\.terminalSettings[\s\S]*\]\);/);
});

test('terminal layer bridge passes vault open callbacks into the side panel context', () => {
  assert.match(source, /onOpenVaultNoteFromChat: s\.onOpenVaultNoteFromChat/);
  assert.match(source, /onOpenVaultHostFromChat: s\.onOpenVaultHostFromChat/);
  assert.match(source, /onOpenVaultSectionFromChat: s\.onOpenVaultSectionFromChat/);
});

test('terminal layer bridge updates side panel live state after render', () => {
  assert.match(source, /const sidePanelLiveSnapshot = useMemo<SidePanelLiveSnapshot>/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s*sidePanelLiveStore\.update\(sidePanelLiveSnapshot\);\s*\}, \[sidePanelLiveSnapshot\]\);/,
  );
  assert.doesNotMatch(source, /sidePanelLiveStore\.update\(\{\s*sftpActiveHost/);
});
