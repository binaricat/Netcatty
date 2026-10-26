import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { STORAGE_KEY_AI_PRIVACY } from '../../../../infrastructure/config/storageKeys';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/settings' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle', 'localStorage'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../../../application/i18n/I18nProvider');
const { AIPrivacySection } = await import('./AIPrivacySection');

async function mount(setConfig: (config: unknown) => Promise<unknown> = async () => ({ ok: true }), saved?: string) {
  dom.window.localStorage.clear();
  if (saved) dom.window.localStorage.setItem(STORAGE_KEY_AI_PRIVACY, saved);
  Object.assign(window, { netcatty: { externalMcpSetConfig: setConfig } });
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<I18nProvider locale="en"><AIPrivacySection /></I18nProvider>));
  return async () => { await act(async () => root.unmount()); };
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
async function input(index: number, value: string) {
  const el = document.querySelectorAll('textarea')[index];
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

test('privacy overview is persisted state; configuration preserves the full scope and atomic draft', async () => {
  const unmount = await mount();
  try {
    assert.equal(document.querySelector('textarea'), null);
    assert.match(document.body.textContent!, /Text redaction disabled/);
    await click('Configure privacy');
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /cannot detect every secret/);
    assert.match(dialog.textContent!, /Catty, integrated agents and external MCP clients/);
    assert.match(dialog.textContent!, /Only Netcatty-managed data and tools are covered/);
    assert.match(dialog.textContent!, /native tools, direct file access and other MCP servers/);
    assert.match(dialog.textContent!, /Binary tool responses are blocked/);
    assert.match(dialog.textContent!, /one managed conversation or external MCP connection/);
    assert.match(dialog.textContent!, /reconnect external MCP clients/);
    assert.equal(dialog.querySelectorAll('[role="switch"][aria-checked="false"]').length, 2);
    assert.equal(button('Apply').disabled, true);
  } finally { await unmount(); }
});

test('rejected privacy draft stays open and accepted draft commits once and returns focus', async () => {
  const calls: unknown[] = [];
  let accepted = false;
  const unmount = await mount(async (config) => { calls.push(config); return accepted ? { ok: true } : { ok: false, error: 'Invalid privacy rules.' }; });
  try {
    const trigger = button('Configure privacy');
    trigger.focus();
    await click('Configure privacy');
    await act(async () => (document.querySelector('[aria-label="Enable text redaction"]') as HTMLButtonElement).click());
    await input(0, '192.0.2.0/24\n\n2001:db8::/32');
    await input(1, '[');
    assert.equal(calls.length, 0);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_PRIVACY), null);
    await click('Apply');
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Invalid privacy rules/);
    assert.equal(document.querySelectorAll('textarea')[1].value, '[');
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_PRIVACY), null);
    accepted = true;
    await input(1, 'INTERNAL_[A-Z0-9]+');
    await click('Apply');
    const saved = JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_PRIVACY)!);
    assert.deepEqual(saved, { enabled: true, redactPrivateIps: false, cidrs: ['192.0.2.0/24', '2001:db8::/32'], patterns: ['INTERNAL_[A-Z0-9]+'] });
    assert.deepEqual(calls[1], { redaction: saved });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.match(document.querySelector('[role="status"]')!.textContent!, /new managed conversation/);
    await click('Configure privacy');
    assert.equal(document.querySelectorAll('textarea')[1].value, 'INTERNAL_[A-Z0-9]+');
  } finally { await unmount(); }
});

test('Cancel, X and Escape discard edits and reopening reads saved values', async () => {
  let calls = 0;
  const unmount = await mount(async () => { calls += 1; return { ok: true }; });
  try {
    for (const close of ['Cancel', 'X', 'Escape']) {
      await click('Configure privacy');
      await input(0, '192.0.2.0/24');
      assert.match(document.querySelector('[role="status"]')!.textContent!, /Unsaved changes/);
      if (close === 'Cancel') await click('Cancel');
      else if (close === 'X') await act(async () => (document.querySelector('[data-dialog-close]:not([aria-hidden])') as HTMLButtonElement).click());
      else await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(document.querySelector('[role="dialog"]'), null);
      await click('Configure privacy');
      assert.equal(document.querySelector('textarea')!.value, '');
      await click('Cancel');
    }
    assert.equal(calls, 0);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_PRIVACY), null);
  } finally { await unmount(); }
});

test('busy Apply blocks duplicate submits, edits and Escape', async () => {
  let resolve!: (value: unknown) => void;
  let calls = 0;
  const unmount = await mount(() => { calls += 1; return new Promise((done) => { resolve = done; }); });
  try {
    await click('Configure privacy');
    await input(0, '192.0.2.0/24');
    await click('Apply');
    assert.ok([...document.querySelectorAll('[role="dialog"] textarea, [role="dialog"] [role="switch"]')].every((el) => (el as HTMLInputElement).disabled));
    assert.equal(button('Cancel').disabled, true);
    await act(async () => { button('Applying...').click(); document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(calls, 1);
    await act(async () => { resolve({ ok: true }); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await unmount(); }
});

test('malformed saved settings remain visible and repairable without being rewritten on open', async () => {
  const unmount = await mount(undefined, '{');
  try {
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Invalid saved AI privacy settings/);
    await click('Configure privacy');
    assert.equal(button('Apply').disabled, false);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_PRIVACY), '{');
  } finally { await unmount(); }
});

test('cross-window changes refresh clean drafts but preserve dirty drafts with a conflict notice', async () => {
  const unmount = await mount();
  const settings = { enabled: true, redactPrivateIps: true, cidrs: ['192.0.2.0/24'], patterns: ['INTERNAL_.*'] };
  const update = async () => {
    dom.window.localStorage.setItem(STORAGE_KEY_AI_PRIVACY, JSON.stringify(settings));
    await act(async () => { window.dispatchEvent(new dom.window.StorageEvent('storage', { key: STORAGE_KEY_AI_PRIVACY })); });
  };
  try {
    await click('Configure privacy');
    await update();
    assert.equal(document.querySelector('textarea')!.value, '192.0.2.0/24');
    await input(0, '198.51.100.0/24');
    settings.cidrs = ['203.0.113.0/24'];
    await update();
    assert.equal(document.querySelector('textarea')!.value, '198.51.100.0/24');
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /another window/);
    assert.equal(button('Apply').disabled, true);
    await click('Cancel');
    await click('Configure privacy');
    assert.equal(document.querySelector('textarea')!.value, '203.0.113.0/24');
  } finally { await unmount(); }
});
