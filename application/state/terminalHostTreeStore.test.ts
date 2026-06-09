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

const { terminalHostTreeStore } = await import('./terminalHostTreeStore.ts');

test('closing host tree keeps layout width until the sidebar animation releases it', () => {
  terminalHostTreeStore.setIsOpen(true);
  terminalHostTreeStore.setLayoutWidth(240);

  terminalHostTreeStore.setIsOpen(false);

  assert.equal(terminalHostTreeStore.getLayoutWidth(), 240);
  terminalHostTreeStore.setLayoutWidth(0);
});
