import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  getAppHostTreeLayerStyle,
} = await import('./AppHostTreeLayer');
const hostTreeLayerSource = readFileSync(new URL('./AppHostTreeLayer.tsx', import.meta.url), 'utf8');

test('shared host tree layer is visible above work tabs', () => {
  assert.deepEqual(getAppHostTreeLayerStyle(true), {
    visibility: 'visible',
    pointerEvents: 'auto',
    zIndex: 30,
  });
});

test('shared host tree layer is hidden behind root pages', () => {
  assert.deepEqual(getAppHostTreeLayerStyle(false), {
    visibility: 'hidden',
    pointerEvents: 'none',
    zIndex: 0,
  });
});

test('shared host tree does not force open when entering a work tab surface', () => {
  assert.doesNotMatch(hostTreeLayerSource, /setIsOpen\(true\)/);
  assert.doesNotMatch(hostTreeLayerSource, /shouldAutoOpenHostTreeOnSurfaceChange/);
});

test('host tree layer hides immediately when leaving work tab surfaces', () => {
  assert.match(hostTreeLayerSource, /getAppHostTreeLayerStyle\(surfaceVisible\)/);
  assert.doesNotMatch(hostTreeLayerSource, /layerVisible/);
});

test('shared host tree theme follows active chrome resolution and manual chrome injection', () => {
  assert.match(hostTreeLayerSource, /resolveActiveChromeTheme/);
  assert.match(hostTreeLayerSource, /useManualTerminalChromeSurfaceInjection/);
  assert.match(hostTreeLayerSource, /resolveSessionAppearance/);
});

test('shared host tree forwards work-surface host management callbacks', () => {
  assert.match(hostTreeLayerSource, /onNewHost=\{onNewHost\}/);
  assert.match(hostTreeLayerSource, /onEditHost=\{onEditHost\}/);
});
