import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { PluginPackageManager } from './PluginPackageManager';
import type { usePluginManager } from '../../../application/state/usePluginManager';

test('state pill exposes actual state, opposite action, focus styling and pending disable without granting permissions', async () => {
  const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT; globals.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: unknown[] = [];
  const plugin = { id: 'com.test.pill', activeVersion: '1.0.0', enabled: true, manifest: { name: 'Pill' }, runtime: {} } as NetcattyInstalledPlugin;
  const manager = { available: true, plugins: [plugin], busy: false, setEnabled: async (...args: unknown[]) => { calls.push(args); } } as unknown as ReturnType<typeof usePluginManager>;
  let renderer: ReactTestRenderer;
  const render = (enabled: boolean, busy = false) => <I18nProvider locale="en"><PluginPackageManager manager={{ ...manager, busy, plugins: [{ ...plugin, enabled }] }} /></I18nProvider>;
  try {
    await act(async () => { renderer = create(render(true)); });
    const pill = () => renderer.root.findAllByType('button').find((node) => node.props['aria-pressed'] !== undefined)!;
    assert.equal(pill().props['aria-pressed'], true);
    const logoSlot = renderer.root.findAllByType('div').find((node) => node.props.className === 'flex h-12 w-12 shrink-0 items-center justify-center');
    assert.ok(logoSlot, 'logo keeps its 48px layout slot without an extra decorative background');
    assert.equal(pill().props['aria-label'], 'Disable Pill');
    assert.ok(pill().children.includes('Enabled'));
    assert.match(pill().props.className, /rounded-full/);
    assert.match(pill().props.className, /border-0/);
    assert.doesNotMatch(pill().props.className, /border-primary|border-border/);
    assert.match(pill().props.className, /bg-primary\/10/);
    assert.match(pill().props.className, /focus-visible:ring-2/);
    assert.match(pill().props.style.color, /--primary/);
    await act(async () => pill().props.onClick());
    assert.deepEqual(calls, [['com.test.pill', false]]);
    await act(async () => renderer.update(render(false, true)));
    assert.equal(pill().props['aria-pressed'], false);
    assert.equal(pill().props['aria-label'], 'Enable Pill');
    assert.ok(pill().children.includes('Disabled'));
    assert.equal(pill().props.disabled, true);
    assert.equal(pill().props['aria-busy'], true);
    assert.match(pill().props.className, /bg-muted/);
    assert.equal(pill().props.style, undefined);
    await act(async () => renderer.unmount());
  } finally { globals.IS_REACT_ACT_ENVIRONMENT = previous; }
});
