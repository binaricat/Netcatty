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
  assert.equal(clampTerminalHostTreeWidth(80), 176);
  assert.equal(clampTerminalHostTreeWidth(999), 360);
  assert.equal(clampTerminalHostTreeWidth(0), 176);
  assert.equal(TERMINAL_HOST_TREE_DEFAULT_WIDTH, 220);
});

test('host tree layout width tracks animated transition flag and deduplicates identical updates', () => {
  terminalHostTreeStore.setLayoutWidth(0, false);
  let notifications = 0;
  const unsubscribe = terminalHostTreeStore.subscribe(() => {
    notifications += 1;
  });

  try {
    terminalHostTreeStore.setLayoutWidth(220, true);
    assert.equal(terminalHostTreeStore.getLayoutWidth(), 220);
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), true);
    assert.equal(notifications, 1);

    // Repeating same (width, animated) is a no-op.
    terminalHostTreeStore.setLayoutWidth(220, true);
    assert.equal(notifications, 1);

    // Clearing animated flag notifies once while keeping layoutWidth intact.
    terminalHostTreeStore.setLayoutTransitionAnimated(false);
    assert.equal(terminalHostTreeStore.getLayoutWidth(), 220);
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), false);
    assert.equal(notifications, 2);

    // Repeating clear is a no-op.
    terminalHostTreeStore.setLayoutTransitionAnimated(false);
    assert.equal(notifications, 2);
  } finally {
    unsubscribe();
    terminalHostTreeStore.setLayoutWidth(0, false);
  }
});
