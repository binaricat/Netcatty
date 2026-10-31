import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TerminalSessionTabs } from './TerminalSessionTabs';
import { SessionInlineRenameInput } from '../terminal/SessionInlineRenameInput';
import type { TerminalSession, TerminalTheme } from '../../types';

const session = (id: string): TerminalSession => ({
  id, hostId: 'host', hostLabel: 'Production', hostname: 'example.test', username: 'root', status: 'connected',
});

test('session tabs select, add, close, rename and cancel with keyboard support', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let root: ReactTestRenderer;
  t.after(async () => {
    await act(async () => root?.unmount());
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const selected: string[] = [];
  const closed: string[] = [];
  const renamed: [string, string][] = [];
  let added = 0;
  await act(async () => {
    root = create(React.createElement(TerminalSessionTabs, {
      sessions: [session('a'), session('b')], selectedSessionId: 'a',
      onSelect: id => selected.push(id), onClose: id => closed.push(id),
      onAdd: () => { added += 1; }, onRename: (id, name) => renamed.push([id, name]),
      theme: { colors: {} } as TerminalTheme,
      t: key => key,
    }), { createNodeMock: () => ({ focus() {}, select() {}, scrollIntoView() {} }) });
  });
  const tabs = () => root.root.findAllByProps({ role: 'tab' });
  assert.equal(tabs().length, 2);
  assert.equal(tabs()[0].props['aria-selected'], true);
  await act(async () => tabs()[1].props.onClick());
  assert.deepEqual(selected, ['b']);
  const add = root.root.findByProps({ 'aria-label': 'terminal.sessions.add' });
  await act(async () => add.props.onClick());
  assert.equal(added, 1);
  let stopped = false;
  await act(async () => tabs()[1].findByType('button').props.onClick({ stopPropagation() { stopped = true; } }));
  assert.equal(stopped, true);
  assert.deepEqual(closed, ['b']);
  assert.deepEqual(selected, ['b'], 'closing does not also select the tab');
  await act(async () => tabs()[1].props.onDoubleClick());
  await act(async () => root.root.findByType(SessionInlineRenameInput).props.onCommit('Deploy'));
  assert.deepEqual(renamed, [['b', 'Deploy']]);
  await act(async () => tabs()[0].props.onDoubleClick());
  await act(async () => root.root.findByType(SessionInlineRenameInput).props.onCancel());
  assert.deepEqual(renamed, [['b', 'Deploy']], 'cancel leaves the name unchanged');
  assert.equal(root.root.findAllByType(SessionInlineRenameInput).length, 0);
  const currentTarget = { parentElement: undefined };
  await act(async () => tabs()[0].props.onKeyDown({ key: 'ArrowRight', target: currentTarget, currentTarget, preventDefault() {} }));
  assert.deepEqual(selected, ['b', 'b']);
});
