import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { I18nProvider } from '../../../../application/i18n/I18nProvider';
import { TooltipProvider } from '../../../ui/tooltip';
import { ProviderConfigForm } from './ProviderConfigForm';
import type { ProviderConfig } from '../../../../infrastructure/ai/types';

const sealed = `enc:v1:${Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 3)]).toString('base64')}`;

test('loading saved headers preserves model metadata and blocks saving until decrypted', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let unlock!: (value: string) => void;
  Object.assign(dom.window, { netcatty: {
    credentialsDecrypt: () => new Promise<string>((resolve) => { unlock = resolve; }),
    credentialsEncrypt: async () => sealed,
  } });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  let saved: Partial<ProviderConfig> | undefined;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><TooltipProvider>
      <ProviderConfigForm provider={{ id: 'custom', providerId: 'custom', enabled: true,
        customHeaders: { 'X-Tenant': sealed }, modelContextWindows: { model: 12345 },
      }} onSave={(updates) => { saved = updates; }} onCancel={() => {}} />
    </TooltipProvider></I18nProvider>));
    const save = () => [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    assert.equal(save().disabled, true);
    await act(async () => { unlock('tenant-secret'); });
    assert.equal(save().disabled, false);
    assert.equal((dom.window.document.querySelector('[aria-label="Header value"]') as HTMLInputElement).value, 'tenant-secret');
    await act(async () => save().click());
    assert.deepEqual(saved?.customHeaders, { 'X-Tenant': sealed });
    assert.deepEqual(saved?.modelContextWindows, { model: 12345 });
    await act(async () => (dom.window.document.querySelector('[aria-label="Remove header"]') as HTMLButtonElement).click());
    await act(async () => save().click());
    assert.deepEqual(saved?.customHeaders, {});
    assert.equal(dom.window.document.querySelector('[aria-label="Header name"]'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
