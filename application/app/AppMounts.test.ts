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

const { getLogViewWrapperStyle } = await import('./AppMounts.tsx');

test('visible log view leaves room for the terminal host sidebar', () => {
  assert.deepEqual(getLogViewWrapperStyle(true, 220), {
    left: 220,
  });
});

test('hidden log view remains hidden while preserving host sidebar offset', () => {
  assert.deepEqual(getLogViewWrapperStyle(false, 220), {
    visibility: 'hidden',
    pointerEvents: 'none',
    position: 'absolute',
    zIndex: -1,
    left: 220,
  });
});
