import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { PluginPackageManager } from './PluginPackageManager';
import type { usePluginManager } from '../../../application/state/usePluginManager';

test('installed grid filters, opens one detail and restores search, scroll and card focus without pill navigation', async () => {
  const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT; globals.IS_REACT_ACT_ENVIRONMENT = true;
  const raf = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const selections: unknown[] = []; const toggles: unknown[] = []; const focus: string[] = [];
  const pane = { scrollTop: 160 };
  const plugins = ['Alpha', 'Beta'].map((name) => ({ id: `com.test.${name.toLowerCase()}`, enabled: false, activeVersion: '1.0.0',
    manifest: { name, publisher: 'Example', description: `${name} safely formats synthetic greetings without accessing hosts or secrets.`, license: 'MIT', main: { browser: 'index.js' }, engines: { api: '0.1.0-internal', netcatty: '*' } },
    runtime: { lastError: name === 'Beta' ? 'Incompatible version' : null },
  })) as NetcattyInstalledPlugin[];
  const manager = { available: true, plugins, busy: false, setEnabled: async (...args: unknown[]) => { toggles.push(args); } } as unknown as ReturnType<typeof usePluginManager>;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<I18nProvider locale="en"><PluginPackageManager manager={manager} onSelectionChange={(id) => selections.push(id)} /></I18nProvider>, {
      createNodeMock: (element) => element.type === 'section' ? {
        closest: () => pane,
        querySelector: () => ({ focus: () => focus.push('detail') }),
        querySelectorAll: () => plugins.map((plugin) => ({ dataset: { pluginCard: plugin.id }, focus: () => focus.push(plugin.id) })),
      } : null,
    }); });
    const cards = () => renderer.root.findAllByType('button').filter((node) => node.props['data-plugin-card']);
    assert.equal(cards().length, 2);
    const alphaCard = renderer.root.findAllByType('article')[0];
    assert.match(JSON.stringify(renderer.toJSON()), /Alpha safely formats synthetic greetings/);
    const authorRow = alphaCard.findByProps({ 'data-plugin-author-row': true });
    assert.ok(authorRow.findAllByType('span').some((node) => node.children.includes('Example')), 'author has its own compact row');
    assert.ok(authorRow.findByProps({ 'data-plugin-author-placeholder': true }), 'an unverified installed publisher has a default avatar');
    assert.ok(alphaCard.findAllByType('p').some((node) => node.props.className?.includes('line-clamp-3')), 'card description is bounded');
    assert.match(JSON.stringify(renderer.toJSON()), /MIT/);
    assert.match(JSON.stringify(renderer.toJSON()), /Incompatible version/);
    assert.ok(renderer.root.findAllByType('div').some((node) => node.props.className?.includes('repeat(auto-fill')));
    const pill = renderer.root.findAllByType('button').find((node) => node.props['aria-pressed'] !== undefined)!;
    await act(async () => pill.props.onClick());
    assert.deepEqual(toggles, [[plugins[0].id, true]]); assert.deepEqual(selections, []);
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'Alpha' } }));
    assert.equal(cards().length, 1);
    await act(async () => cards()[0].props.onClick()); frames.splice(0).forEach((fn) => fn(0));
    assert.deepEqual(selections, [plugins[0].id]); assert.equal(pane.scrollTop, 0); assert.equal(focus.at(-1), 'detail');
    assert.equal(renderer.root.findAllByType('input').length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /Declared permissions/);
    assert.ok(renderer.root.findByType('article').findAllByType('p').some((node) => node.props.className?.includes('whitespace-pre-wrap')), 'detail shows the complete description');
    const back = renderer.root.findAllByType('button').find((node) => node.children.includes('Installed plugins'))!;
    await act(async () => back.props.onClick()); frames.splice(0).forEach((fn) => fn(0));
    assert.equal(renderer.root.findByType('input').props.value, 'Alpha'); assert.equal(cards().length, 1);
    assert.equal(pane.scrollTop, 160); assert.equal(focus.at(-1), plugins[0].id);
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'none' } }));
    assert.equal(cards().length, 0);
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: '' } }));
    await act(async () => renderer.update(<I18nProvider locale="en"><PluginPackageManager manager={{ ...manager, statusKnown: false, error: 'synthetic state unavailable' }} onSelectionChange={(id) => selections.push(id)} /></I18nProvider>));
    const unknown = renderer.root.findAllByType('button').filter((node) => node.children.includes('Status unknown'));
    assert.equal(unknown.length, 2);
    assert.ok(unknown.every((node) => node.props.disabled === true && node.props['aria-pressed'] === undefined));
    await act(async () => renderer.unmount());
  } finally { globals.IS_REACT_ACT_ENVIRONMENT = previous; globalThis.requestAnimationFrame = raf; }
});
