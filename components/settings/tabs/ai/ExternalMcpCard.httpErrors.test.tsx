import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { installAiToolAccessFixture } from '../../../../scripts/fixtures/ai-tool-access/bridge.cjs';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/settings' });
for (const key of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle', 'localStorage'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../../../application/i18n/I18nProvider');
const { TooltipProvider } = await import('../../../ui/tooltip');
const { ExternalMcpCard } = await import('./ExternalMcpCard');

type FixtureControl = { rejectHttp: boolean; throwHttp: boolean; holdHttp: boolean; pendingHttp: (() => void)[]; pendingClients: (() => void)[]; rejectRotate: boolean; throwRotate: boolean; calls: { name: string; args: unknown[] }[] };
async function mount(options: { enabled?: boolean; holdClients?: boolean } = {}, openHttp = true) {
  installAiToolAccessFixture({ locale: 'en', enabled: true, ...options });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  const qa = (window as unknown as { __aiToolQa: FixtureControl }).__aiToolQa;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<I18nProvider locale="en"><TooltipProvider><ExternalMcpCard /></TooltipProvider></I18nProvider>));
  if (openHttp) await click('Configure HTTP');
  return { qa, close: async () => { await act(async () => root.unmount()); } };
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
async function changePort(value: string) {
  const port = dialog().querySelector<HTMLInputElement>('[aria-label="Port"]')!;
  await act(async () => {
    port.focus();
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(port, value);
    port.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => port.blur());
  return port;
}

for (const failure of ['returned', 'thrown'] as const) {
  test(`HTTP ${failure} configuration failure is visible inside the dialog, preserves input and can retry`, async () => {
    const h = await mount();
    try {
      h.qa.rejectHttp = failure === 'returned';
      h.qa.throwHttp = failure === 'thrown';
      const port = await changePort('47401');
      const message = failure === 'returned' ? 'Fixture: port unavailable.' : 'Fixture: HTTP configuration threw.';
      const alert = dialog().querySelector('[role="alert"]')!;
      assert.match(alert.textContent!, new RegExp(message.replaceAll('.', '\\.')));
      assert.equal(document.activeElement, alert, 'the error must be reachable without scrolling back manually');
      assert.equal(port.value, '47401');
      assert.ok(document.querySelector('[role="dialog"]'));
      assert.match(document.querySelector('[data-settings-anchor="ai-external-mcp-http"]')!.textContent!, /Fixture:/);
      const beforeRetry = h.qa.calls.filter((call) => call.name === 'config').length;
      h.qa.rejectHttp = false;
      h.qa.throwHttp = false;
      await click('Retry');
      assert.equal(h.qa.calls.filter((call) => call.name === 'config').length, beforeRetry + 1);
      assert.equal(dialog().querySelector('[role="alert"]'), null);
      assert.equal(port.value, '47401');
    } finally { await h.close(); }
  });
}

for (const failure of ['returned', 'thrown'] as const) {
  test(`HTTP ${failure} token rotation failure stays in the active dialog and retries explicitly`, async () => {
    const h = await mount();
    try {
      await act(async () => (dialog().querySelector('[aria-label="Enable HTTP"]') as HTMLButtonElement).click());
      await act(async () => dialog().querySelector('summary')!.click());
      h.qa.rejectRotate = failure === 'returned';
      h.qa.throwRotate = failure === 'thrown';
      await click('Regenerate');
      assert.match(dialog().querySelector('[role="alert"]')!.textContent!, /Fixture: token rotation/);
      assert.equal(dialog().textContent!.includes('SYNTHETIC_FIXTURE_TOKEN_NEVER_REAL'), false);
      h.qa.rejectRotate = false;
      h.qa.throwRotate = false;
      await click('Retry');
      assert.equal(dialog().querySelector('[role="alert"]'), null);
      assert.equal(dialog().textContent!.includes('SYNTHETIC_ROTATED_FIXTURE_TOKEN'), false);
    } finally { await h.close(); }
  });
}

test('HTTP clipboard failure is visible in the dialog and clears only after another copy attempt', async () => {
  const h = await mount();
  try {
    await act(async () => dialog().querySelector('summary')!.click());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Fixture clipboard failure'); } } });
    const copy = () => dialog().querySelector<HTMLButtonElement>('[aria-label="Copy"]:not([disabled])')!;
    await act(async () => copy().click());
    assert.match(dialog().querySelector('[role="alert"]')!.textContent!, /copy/i);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    await act(async () => copy().click());
    assert.equal(dialog().querySelector('[role="alert"]'), null);
  } finally { await h.close(); }
});

for (const failure of ['returned', 'thrown'] as const) {
  test(`a completed runtime poll cannot suppress a pending HTTP ${failure} failure`, async () => {
    const h = await mount();
    try {
      h.qa.holdHttp = true;
      h.qa.rejectHttp = failure === 'returned';
      h.qa.throwHttp = failure === 'thrown';
      const beforePoll = h.qa.calls.filter((call) => call.name === 'status').length;
      const port = await changePort('47402');
      assert.match(dialog().querySelector('[role="status"]')!.textContent!, /Applying HTTP/);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3200)); });
      assert.ok(h.qa.calls.filter((call) => call.name === 'status').length > beforePoll);
      await act(async () => h.qa.pendingHttp.splice(0).forEach((resolve) => resolve()));
      assert.match(dialog().querySelector('[role="alert"]')!.textContent!, /Fixture:/);
      assert.equal(port.value, '47402');
      assert.equal(dialog().querySelector('[role="status"]'), null);
    } finally { await h.close(); }
  });
}

test('completed MCP enable can be turned off while unrelated client discovery is still pending', async () => {
  const h = await mount({ enabled: false, holdClients: true }, false);
  try {
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="External MCP"]')!;
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.ok(h.qa.pendingClients.length > 0, 'client discovery remains intentionally unresolved');
    assert.equal(toggle.disabled, false, 'successful enable must release the switch before client discovery finishes');
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(toggle.disabled, false);
    assert.deepEqual(h.qa.calls.filter((call) => call.name === 'enable').map((call) => call.args[0]), [true, false]);
  } finally { await h.close(); }
});
