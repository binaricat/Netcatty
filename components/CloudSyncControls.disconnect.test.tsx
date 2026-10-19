import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { I18nProvider } from '../application/i18n/I18nProvider';
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment, runWithAct } from './test-support/renderReactDom';

test('provider disconnect waits for completion, reports failure and permits retry', async () => {
  const dom = installDomEnvironment();
  const globals = {
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    NodeFilter: dom.window.NodeFilter,
    HTMLInputElement: dom.window.HTMLInputElement,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { ProviderCard } = await import('./cloud-sync/CloudSyncControls');
  const { toast } = await import('./ui/toast');
  const renderer = await createDomRenderer(dom.document);
  const notices: string[] = [];
  const info = toast.info;
  const error = toast.error;
  toast.info = (message) => { notices.push(`info:${message}`); };
  toast.error = (message) => { notices.push(`error:${message}`); };
  let finish: (() => void) | undefined;
  let fail = true;
  let calls = 0;
  try {
    await renderer.render(
      <I18nProvider locale="en">
        <ProviderCard provider="webdav" name="WebDAV" icon={null} isConnected isSyncing={false}
          onConnect={() => {}} onSync={() => {}}
          onDisconnect={() => {
            calls += 1;
            if (fail) throw new Error('fixture failure');
            return new Promise<void>((resolve) => { finish = resolve; });
          }} />
      </I18nProvider>,
    );
    const click = async (node: Element) => {
      await dispatchDomEvent(node, new dom.window.MouseEvent('click', { bubbles: true }));
      await flushEffects();
    };
    const button = dom.document.querySelector('button[aria-label="Disconnect"]');
    assert.ok(button);
    assert.equal(button.textContent, 'Disconnect');
    await click(button);
    let dialog = dom.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /backup history and sync encryption password stay here/);
    const confirm = () => {
      const node = [...dom.document.querySelectorAll('[role="dialog"] button')].find((el) => el.textContent === 'Disconnect');
      assert.ok(node);
      return node as HTMLButtonElement;
    };
    await click(confirm());
    assert.equal(calls, 1);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^error:Could not finish disconnecting from WebDAV/);
    assert.ok(dom.document.querySelector('[role="dialog"]'));
    assert.equal(confirm().disabled, false);
    fail = false;
    await click(confirm());
    assert.equal(calls, 2);
    assert.equal(confirm().disabled, true);
    assert.equal(notices.length, 1);
    await runWithAct(async () => { finish?.(); });
    await flushEffects();
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(notices.length, 2);
    assert.match(notices[1], /^info:Encrypted sync copies may still exist in your WebDAV storage/);
    assert.doesNotMatch(notices[1], /\{name\}/);
    // Cancelling a new confirmation never calls the disconnect callback.
    await click(button);
    dialog = dom.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const cancel = [...dialog.querySelectorAll('button')].find((el) => el.textContent === 'Cancel');
    assert.ok(cancel);
    await click(cancel);
    assert.equal(calls, 2);
  } finally {
    toast.info = info;
    toast.error = error;
    await renderer.unmount();
    // Radix restores focus on a timer after unmount. Keep the DOM globals
    // installed until that cleanup has dispatched its final event.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  }
});
