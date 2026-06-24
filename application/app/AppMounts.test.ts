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

const { getLogViewWrapperStyle, shouldRenderTerminalLayerMount } = await import('./AppMounts.tsx');
const activeTabChromeSource = readFileSync(new URL('./AppActiveTabChrome.tsx', import.meta.url), 'utf8');
const appViewSource = readFileSync(new URL('./AppView.tsx', import.meta.url), 'utf8');
const appMountsSource = readFileSync(new URL('./AppMounts.tsx', import.meta.url), 'utf8');
const globalCssSource = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

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

test('terminal layer renders only after terminal content is visible or mounted', () => {
  assert.equal(shouldRenderTerminalLayerMount(true, false), true);
  assert.equal(shouldRenderTerminalLayerMount(false, true), true);
  assert.equal(shouldRenderTerminalLayerMount(false, false), false);
});

test('inactive app surfaces suppress background color transitions', () => {
  assert.match(appMountsSource, /data-inactive-app-surface=\{isActive \? undefined : "true"\}/);
  assert.match(appMountsSource, /data-inactive-app-surface=\{isVisible \? undefined : "true"\}/);
  assert.match(globalCssSource, /\[data-inactive-app-surface\][\s\S]*transition: none !important;/);
});

test('vault activation suppresses inherited text color transitions', () => {
  assert.match(appMountsSource, /data-app-surface-transition-suppressed/);
  assert.match(appMountsSource, /setSuppressActiveTransition\(false\)/);
  assert.match(globalCssSource, /\[data-app-surface-transition-suppressed\][\s\S]*transition: none !important;/);
});

test('vault surface carries app theme vars while terminal chrome is active', () => {
  assert.match(appMountsSource, /appThemeStyle\?: React\.CSSProperties/);
  assert.match(appMountsSource, /style=\{\{ \.\.\.appThemeStyle, \.\.\.containerStyle \}\}/);
  assert.match(appViewSource, /buildAppThemeCssVars\(tokens, accentMode, customAccent\)/);
  assert.match(appViewSource, /<VaultViewContainer appThemeStyle=\{appThemeStyle\}>/);
});

test('active tab chrome keeps removed theme side effects unmounted', () => {
  const removedThemeHook = ['use', 'Im', 'mersive', 'Mode'].join('');
  const removedThemeStoreSetter = ['set', 'Im', 'mersive', 'Active'].join('');
  assert.equal(activeTabChromeSource.includes(removedThemeHook), false);
  assert.equal(activeTabChromeSource.includes(removedThemeStoreSetter), false);
});
