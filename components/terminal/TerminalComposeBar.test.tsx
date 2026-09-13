import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TerminalComposeBar } from './TerminalComposeBar';
import { TooltipProvider } from '../ui/tooltip';
import { getComposeBarHistory, pruneComposeBarHistory, recordComposeBarHistory } from '../../application/state/composeBarHistoryStore';

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
