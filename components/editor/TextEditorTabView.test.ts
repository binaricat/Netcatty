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

const { getTextEditorTabShellStyle } = await import('./TextEditorTabView');

test('visible editor tab leaves room for the terminal host sidebar', () => {
  assert.deepEqual(getTextEditorTabShellStyle(true, 280), {
    zIndex: 20,
    left: 280,
  });
});

test('hidden editor tab stays hidden', () => {
  assert.deepEqual(getTextEditorTabShellStyle(false, 280), {
    pointerEvents: 'none',
    visibility: 'hidden',
    zIndex: 20,
    left: 280,
  });
});
