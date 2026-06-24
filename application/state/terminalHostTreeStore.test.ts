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
  TERMINAL_HOST_TREE_DEFAULT_WIDTH,
  clampTerminalHostTreeWidth,
  terminalHostTreeStore,
} = await import('./terminalHostTreeStore.ts');

test('closing host tree state does not mutate layout width by itself', () => {
  terminalHostTreeStore.setIsOpen(true);
  terminalHostTreeStore.setLayoutWidth(240);

  terminalHostTreeStore.setIsOpen(false);

  assert.equal(terminalHostTreeStore.getLayoutWidth(), 240);
  terminalHostTreeStore.setLayoutWidth(0);
});

test('opening host tree state does not jump the layout width', () => {
  storage.set('netcatty_terminal_host_tree_width_v1', '300');
  terminalHostTreeStore.setLayoutWidth(0);
  terminalHostTreeStore.setIsOpen(false);

  terminalHostTreeStore.setIsOpen(true);

  assert.equal(terminalHostTreeStore.getLayoutWidth(), 0);
  terminalHostTreeStore.setLayoutWidth(0);
});

test('host tree restored layout width is clamped', () => {
  assert.equal(clampTerminalHostTreeWidth(80), 132);
  assert.equal(clampTerminalHostTreeWidth(999), 360);
  assert.equal(clampTerminalHostTreeWidth(0), 132);
  assert.equal(TERMINAL_HOST_TREE_DEFAULT_WIDTH, 220);
});
