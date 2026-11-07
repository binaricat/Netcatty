import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { I18nProvider } from '../application/i18n/I18nProvider';
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment } from './test-support/renderReactDom';

test('a rejected palette plugin command shows bounded existing toast feedback without raw diagnostics or retry', async () => {
  const dom = installDomEnvironment();
  const globals = { localStorage: dom.window.localStorage, Element: dom.window.Element, ResizeObserver: class { observe() {} disconnect() {} } };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { QuickSwitcher } = await import('./QuickSwitcher');
  const { toast } = await import('./ui/toast');
  const renderer = await createDomRenderer(dom.document);
  const notices: string[] = [], calls: unknown[][] = [];
  const error = toast.error;
  toast.error = (message) => { notices.push(message); };
  Object.defineProperty(dom.window, 'netcatty', { value: {
    getPluginRuntimeStatus: async () => ({ available: true }),
    getPluginContributions: async () => ({ locale: 'en', plugins: [{
      id: 'com.example.selection', version: '1.0.0', displayName: 'Synthetic selection', description: '',
      commands: [{ id: 'com.example.selection.share', title: 'Share selected terminal', enabled: true }],
      menus: [{ id: 'menu', command: 'com.example.selection.share', title: 'Share selected terminal', location: 'commandPalette', visible: true, enabled: true }],
      keybindings: [], settings: [], views: [],
    }] }),
    executePluginCommand: async (...args: unknown[]) => { calls.push(args); throw new Error('synthetic-private-diagnostic'); },
  } });
  let closes = 0;
  try {
    await renderer.render(<I18nProvider locale="en"><QuickSwitcher isOpen query="Share selected terminal" results={[]} sessions={[]} workspaces={[]}
      onQueryChange={() => {}} onSelect={() => {}} onSelectTab={() => {}} onClose={() => { closes++; }} showSftpTab={false} /></I18nProvider>);
    await flushEffects(); await flushEffects();
    const button = [...dom.document.querySelectorAll('button')].find((node) => node.textContent?.includes('Share selected terminal'));
    assert.ok(button);
    await dispatchDomEvent(button, new dom.window.MouseEvent('click', { bubbles: true }));
    await flushEffects();
    assert.equal(calls.length, 1);
    assert.equal(closes, 1);
    assert.deepEqual(notices, ['The plugin command could not be completed. Check its required selection and permissions.']);
    assert.equal(notices.join('').includes('synthetic-private-diagnostic'), false);
  } finally {
    toast.error = error;
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  }
});
