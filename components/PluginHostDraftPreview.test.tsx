import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { I18nProvider } from '../application/i18n/I18nProvider';
import { PluginHostDraftPreview } from './plugins/PluginHostDraftPreview';
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from './test-support/renderReactDom';
import type { Host } from '../domain/models';
import type { PluginHostDraftFields } from '../domain/pluginHostActions';

test('host-owned draft preview shows a field diff and submits only reviewed editable fields', async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const host: Host = { id: 'synthetic', label: 'Before', hostname: 'host.invalid', username: 'test', tags: [], os: 'linux', password: 'synthetic-password', startupCommand: 'synthetic-script' };
  const submitted: PluginHostDraftFields[] = [];
  try {
    await renderer.render(<I18nProvider locale="en"><PluginHostDraftPreview before={host} draft={{ label: 'After' }} busy={false} onConfirm={(draft) => submitted.push(draft)} /></I18nProvider>);
    assert.equal(dom.document.querySelectorAll('input').length, 3);
    assert.match(renderer.container.textContent ?? '', /Before.*After/u);
    assert.equal(renderer.container.innerHTML.includes('synthetic-password'), false);
    assert.equal(renderer.container.innerHTML.includes('synthetic-script'), false);
    const save = dom.document.querySelector('button');
    assert.ok(save);
    await dispatchDomEvent(save, new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(submitted, [{ label: 'After', group: '', tags: [] }]);
  } finally { await renderer.unmount(); dom.cleanup(); }
});

test('invalid create draft cannot be confirmed', async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  try {
    await renderer.render(<I18nProvider locale="en"><PluginHostDraftPreview draft={{ hostname: 'invalid host' }} busy={false} onConfirm={() => { throw new Error('Invalid draft was submitted'); }} /></I18nProvider>);
    assert.ok(dom.document.querySelector('[role="alert"]'));
    const save = dom.document.querySelector('button');
    assert.ok(save?.disabled);
    await dispatchDomEvent(save, new dom.window.MouseEvent('click', { bubbles: true }));
  } finally { await renderer.unmount(); dom.cleanup(); }
});
