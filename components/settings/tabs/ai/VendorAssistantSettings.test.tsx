import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/settings' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle', 'localStorage'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../../../application/i18n/I18nProvider');
const { VendorAssistantSettings } = await import('./VendorAssistantSettings');

const STATUS = {
  ok: true,
  profileRoot: 'C:\\Users\\me\\AppData\\Roaming\\Netcatty\\vendor-assistant',
  browser: { path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', found: true },
  vendors: [
    { key: 'huawei', name: 'Huawei WeiKnow', url: '', login: 'logged', dir: '' },
    { key: 'ruijie', name: 'Ruijie AZAI', url: '', login: 'unknown', dir: '' },
  ],
};

async function mount(bridge: Record<string, unknown>) {
  Object.assign(window, { netcatty: bridge });
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<I18nProvider locale="en"><VendorAssistantSettings /></I18nProvider>));
  return async () => { await act(async () => root.unmount()); };
}

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === text);

test('lists every vendor with its login state', async () => {
  const unmount = await mount({ aiVendorAssistantStatus: async () => STATUS });
  const text = document.body.textContent ?? '';
  assert.match(text, /Vendor AI assistants/);
  assert.match(text, /Huawei WeiKnow/);
  assert.match(text, /Ruijie AZAI/);
  assert.match(text, /Signed in/);
  assert.match(text, /Not confirmed/);
  assert.match(text, /vendor-assistant/);
  await unmount();
});

test('signing in calls the bridge and refreshes the list', async () => {
  const calls: string[] = [];
  let logged = false;
  const unmount = await mount({
    aiVendorAssistantStatus: async () => ({
      ...STATUS,
      vendors: [{ key: 'huawei', name: 'Huawei WeiKnow', url: '', login: logged ? 'logged' : 'missing', dir: '' }],
    }),
    aiVendorAssistantLogin: async (vendor: string) => {
      calls.push(vendor);
      logged = true;
      return { ok: true, vendor, name: 'Huawei WeiKnow', status: 'ok', text: '', url: '', elapsedMs: 1, error: null };
    },
  });
  const signIn = button('Sign in');
  assert.ok(signIn, 'missing sign-in button');
  await act(async () => { signIn!.click(); });
  assert.deepEqual(calls, ['huawei']);
  assert.match(document.body.textContent ?? '', /Signed in/);
  await unmount();
});

test('a bridge without the vendor API renders the unavailable notice', async () => {
  const unmount = await mount({});
  assert.match(document.body.textContent ?? '', /Not available in this build/);
  await unmount();
});
