import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { loadLocaleMessages } from '../../application/i18n/messages';
import { terminalCwdStore } from '../../application/state/terminalCwdStore';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';
import { registerTerminalDirectory } from '../../application/state/terminalDirectoryRegistry';
import { ComposeDirectoryPicker } from './ComposeDirectoryPicker';
import type { ComposeBarTheme } from './TerminalComposeBar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

for (const home of [null, '/tmp'] as const) {
  test(`chip text, title and ARIA retain the confirmed display during a null cwd (home=${home})`, async t => {
    await loadLocaleMessages('zh-CN');
    const sessionId = 'chip-display-' + home;
    const cwd = '/tmp/test_dir';
    let root!: ReactTestRenderer;
    let unregister = () => {};
    t.after(async () => { await act(async () => { root.unmount(); }); unregister(); });
    await act(async () => {
      root = create(<I18nProvider locale="zh-CN">
        <ComposeDirectoryPicker sessionId={sessionId} theme={{} as ComposeBarTheme} onReturnFocus={() => {}} />
      </I18nProvider>);
    });
    const chip = () => root.root.findByType('button');
    const text = () => root.root.findByProps({ className: 'truncate' }).children.join('');
    assert.equal(text(), '\u76ee\u5f55\u672a\u77e5');
    assert.equal(chip().props.title, text());
    assert.ok(chip().props['aria-label'].includes(text()));

    await act(async () => {
      unregister = registerTerminalDirectory(sessionId, createTerminalDirectoryController({
        sessionId, isCurrent: () => true, isReady: () => true,
        io: { cwd: async () => cwd, home: async () => home, realpath: async path => path,
          write() { assert.fail('display updates must not write to the terminal'); }, list: async () => ({ home, entries: [] }) },
        publish: path => terminalCwdStore.setCwd(sessionId, path, 'backend-strict'),
      }));
    });
    const label = home ? '~/test_dir' : cwd;
    assert.equal(text(), label);
    const aria = chip().props['aria-label'];
    assert.ok(aria.includes(label));
    assert.equal(chip().props.title, cwd);
    await act(async () => { terminalCwdStore.setCwd(sessionId, null); });
    assert.equal(terminalCwdStore.getCwd(sessionId), null);
    assert.equal(text(), label);
    assert.equal(chip().props.title, cwd);
    assert.equal(chip().props['aria-label'], aria);
  });
}
