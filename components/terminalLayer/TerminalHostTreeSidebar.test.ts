import assert from 'node:assert/strict';
import test from 'node:test';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const {
  getTerminalHostTreeSidebarPanelStyle,
  getTerminalHostTreeSidebarShellStyle,
  isTerminalHostTreeSidebarVisible,
} = await import('./TerminalHostTreeSidebar.tsx');

test('host tree sidebar is visually hidden when disabled even if it remains open', () => {
  assert.equal(isTerminalHostTreeSidebarVisible(true, false), false);
});

test('host tree sidebar visibility still follows open state when enabled', () => {
  assert.equal(isTerminalHostTreeSidebarVisible(true, true), true);
  assert.equal(isTerminalHostTreeSidebarVisible(false, true), false);
});

test('host tree sidebar keeps the inner panel width while the shell hides', () => {
  const theme = {
    termBg: '#000000',
    termFg: '#ffffff',
    mutedFg: '#999999',
    separator: '#333333',
    rowHoverBg: '#111111',
    rowActiveBg: '#222222',
    rowDropBg: '#444444',
    folderFg: '#cccccc',
  };

  assert.deepEqual(getTerminalHostTreeSidebarShellStyle(false, 240, 'width 220ms ease'), {
    width: 0,
    transition: 'width 220ms ease',
    pointerEvents: 'none',
  });
  assert.equal(getTerminalHostTreeSidebarPanelStyle({
    isVisible: false,
    displayWidth: 240,
    panelTransition: 'opacity 180ms ease-out',
    theme,
  }).width, 240);
});
