import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { TerminalComposeBar } from './TerminalComposeBar';
import { TooltipProvider } from '../ui/tooltip';
import { getComposeBarHistory, pruneComposeBarHistory, recordComposeBarHistory } from '../../application/state/composeBarHistoryStore';
import { terminalReconnectRegistry } from '../../application/state/terminalReconnectRegistry';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';
import { registerTerminalDirectory, refreshObservedTerminalDirectory } from '../../application/state/terminalDirectoryRegistry';
import { terminalCwdStore } from '../../application/state/terminalCwdStore';

test('disabling Context Chips preserves the compose draft and stops extra cwd refreshes', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let probes = 0;
  const cleanup = registerTerminalDirectory('toggle-test', createTerminalDirectoryController({
    sessionId: 'toggle-test', isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => { probes++; return '/project'; }, list: async () => ({ entries: [], home: null }),
      realpath: async path => path, write() {} },
    publish: cwd => { terminalCwdStore.setCwd('toggle-test', cwd, 'backend-strict'); },
  }));
  const textarea = { value: '', selectionStart: 0, selectionEnd: 0, focus() {},
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
  const render = (enabled: boolean) => <TooltipProvider><TerminalComposeBar sessionId="toggle-test"
    contextChipsEnabled={enabled} onSend={() => true} onClose={() => {}} /></TooltipProvider>;
  let root!: ReactTestRenderer;
  await act(async () => { root = create(render(true), { createNodeMock: el => el.type === 'textarea' ? textarea : null }); });
  assert.equal(probes, 1);
  textarea.value = 'keep this draft'; textarea.selectionStart = 2; textarea.selectionEnd = 8;
  await act(async () => { root.update(render(false)); });
  assert.equal(root.root.findAllByProps({ 'aria-label': 'Context Chips' }).length, 0);
  const before = probes;
  refreshObservedTerminalDirectory('toggle-test');
  await Promise.resolve();
  assert.equal(probes, before);
  assert.equal(textarea.value, 'keep this draft');
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [2, 8]);
  await act(async () => { root.unmount(); });
  cleanup();
});

test('compose bar preserves a draft on pane focus and records only successful async sends', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pruneComposeBarHistory([]);
  const createTextarea = () => ({
    value: '', selectionStart: 0, selectionEnd: 0,
    focus() {},
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
  });
  let textarea = createTextarea();
  let finish!: (sent: boolean) => void;
  let rejectSend!: (error: Error) => void;
  const onSend = () => new Promise<boolean>((resolve, reject) => { finish = resolve; rejectSend = reject; });
  const render = (sessionId: string) => (
    <TooltipProvider><TerminalComposeBar sessionId={sessionId} onSend={onSend} onClose={() => {}} /></TooltipProvider>
  );
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(render('a'), { createNodeMock: (el) => {
      if (el.type !== 'textarea') return null;
      textarea = createTextarea();
      return textarea;
    } });
  });
  const key = (name: string) => root.root.findByType('textarea').props.onKeyDown({
    key: name, nativeEvent: {}, currentTarget: textarea, preventDefault() {},
  });
  textarea.value = 'unsent draft';
  await act(async () => { root.update(render('b')); });
  assert.equal(textarea.value, 'unsent draft');
  await act(async () => { root.update(render('a')); });
  recordComposeBarHistory('a', 'old command from A');
  key('ArrowUp');
  assert.equal(textarea.value, 'old command from A');
  await act(async () => { root.update(render('b')); });
  assert.equal(textarea.value, 'unsent draft');
  key('Enter');
  assert.equal(textarea.value, '');
  assert.deepEqual(getComposeBarHistory('b'), []);
  await act(async () => { finish(false); });
  assert.deepEqual(getComposeBarHistory('b'), []);
  textarea.value = 'accepted command';
  key('Enter');
  textarea.value = 'next draft';
  await act(async () => { finish(true); });
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command']);
  assert.equal(textarea.value, 'next draft');
  key('ArrowUp');
  assert.equal(textarea.value, 'accepted command');
  key('ArrowDown');
  assert.equal(textarea.value, 'next draft');
  textarea.value = 'first';
  key('Enter');
  const finishFirst = finish;
  textarea.value = 'second';
  key('Enter');
  const finishSecond = finish;
  await act(async () => { finishSecond(true); });
  await act(async () => { finishFirst(true); });
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command', 'first', 'second']);
  key('ArrowUp');
  assert.equal(textarea.value, 'second');
  textarea.value = 'rejected';
  key('Enter');
  const finishRejected = finish;
  textarea.value = 'after rejected';
  key('Enter');
  await act(async () => { finish(true); });
  await act(async () => { finishRejected(false); });
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command', 'first', 'second', 'after rejected']);
  const errorLog = t.mock.method(console, 'error', () => {});
  textarea.value = 'exception';
  key('Enter');
  const rejectFirst = rejectSend;
  textarea.value = 'after exception';
  key('Enter');
  await act(async () => { finish(true); });
  await act(async () => { rejectFirst(new Error('send failed')); });
  assert.equal(errorLog.mock.callCount(), 1);
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command', 'first', 'second', 'after rejected', 'after exception']);
  await act(async () => { root.unmount(); });
  pruneComposeBarHistory([]);
});

test('empty compose draft Enter reconnects; a typed draft still sends', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  const sessionId = 'compose-enter-reconnect';
  const reconnects: string[] = [];
  const unregister = terminalReconnectRegistry.register(sessionId, () => {
    reconnects.push(sessionId);
  });
  t.after(() => {
    unregister();
    terminalReconnectRegistry.setEnterReconnectEnabled(sessionId, false);
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const createTextarea = () => ({
    value: '', selectionStart: 0, selectionEnd: 0,
    focus() {},
    setSelectionRange() {},
  });
  let textarea = createTextarea();
  const sent: string[] = [];
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <TooltipProvider>
        <TerminalComposeBar sessionId={sessionId} onSend={(text) => { sent.push(text); return true; }} onClose={() => {}} />
      </TooltipProvider>,
      { createNodeMock: (el) => {
        if (el.type !== 'textarea') return null;
        textarea = createTextarea();
        return textarea;
      } },
    );
  });
  const key = (name: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    root.root.findByType('textarea').props.onKeyDown({
      key: name,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: {},
      currentTarget: textarea,
      preventDefault() { prevented = true; },
      ...extra,
    });
    return prevented;
  };

  terminalReconnectRegistry.setEnterReconnectEnabled(sessionId, true);
  assert.equal(key('Enter'), true);
  assert.deepEqual(reconnects, [sessionId]);
  assert.deepEqual(sent, []);
  assert.equal(textarea.value, '');

  textarea.value = 'echo hi';
  assert.equal(key('Enter'), true);
  assert.deepEqual(reconnects, [sessionId]);
  assert.deepEqual(sent, ['echo hi']);
  assert.equal(textarea.value, '');

  textarea.value = 'keep me';
  assert.equal(key('Enter', { shiftKey: true }), false);
  assert.equal(textarea.value, 'keep me');
  assert.deepEqual(sent, ['echo hi']);
  assert.deepEqual(reconnects, [sessionId]);

  textarea.value = '';
  assert.equal(key('Enter', { ctrlKey: true }), true);
  assert.deepEqual(sent, ['echo hi']);
  assert.deepEqual(reconnects, [sessionId]);

  assert.equal(key('Enter', { nativeEvent: { isComposing: true, keyCode: 229 } }), false);
  assert.deepEqual(reconnects, [sessionId]);

  terminalReconnectRegistry.setEnterReconnectEnabled(sessionId, false);
  assert.equal(key('Enter'), true);
  assert.deepEqual(reconnects, [sessionId]);
  assert.deepEqual(sent, ['echo hi']);

  await act(async () => { root.unmount(); });
});

test('compose send target toggle shows all vs active without looking like broadcast when active', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const toggles: string[] = [];
  const render = (composeSendToAll: boolean) => (
    <I18nProvider locale="en">
      <TooltipProvider>
        <TerminalComposeBar
          sessionId="compose-target"
          onSend={() => true}
          onClose={() => {}}
          isBroadcastEnabled
          composeSendToAll={composeSendToAll}
          onToggleComposeSendTarget={() => { toggles.push('toggle'); }}
        />
      </TooltipProvider>
    </I18nProvider>
  );
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(render(true), { createNodeMock: (el) => (el.type === 'textarea' ? { focus() {} } : null) });
  });
  const button = root.root.findAll(
    (node) => node.props?.['data-compose-send-target'] === 'all' || node.props?.['data-compose-send-target'] === 'active',
  )[0];
  assert.ok(button);
  assert.equal(button.props['data-compose-send-target'], 'all');
  assert.equal(button.props['aria-pressed'], true);
  assert.match(String(button.props['aria-label']), /all sessions/i);
  const pulsing = root.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('animate-pulse'));
  assert.ok(pulsing.length > 0);
  await act(async () => {
    button.props.onClick({
      preventDefault() {},
      stopPropagation() {},
      defaultPrevented: false,
      nativeEvent: { defaultPrevented: false },
    });
  });
  assert.deepEqual(toggles, ['toggle']);
  await act(async () => { root.update(render(false)); });
  const active = root.root.findAll((node) => node.props?.['data-compose-send-target'] === 'active')[0];
  assert.ok(active);
  assert.equal(active.props['aria-pressed'], false);
  assert.match(String(active.props['aria-label']), /active session/i);
  const stillPulsing = root.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('animate-pulse'));
  assert.equal(stillPulsing.length, 0);
  await act(async () => { root.unmount(); });
});
