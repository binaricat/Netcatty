import assert from 'node:assert/strict';
import test from 'node:test';
import React, { memo } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { TerminalSession, Workspace } from '../../types';
import { useTerminalWorkspaceLayout } from './useTerminalWorkspaceLayout';

test('workspace switches keep mounted pane drop props stable and saved callbacks use the latest layout', async (t) => {
  const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let renderer: ReactTestRenderer | undefined;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    if (previousActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  const sessions = ['a1', 'a2', 'b1', 'b2'].map(id => ({
    id, workspaceId: id[0],
  })) as TerminalSession[];
  const workspaces = ['a', 'b'].map(id => ({
    id, title: id,
    root: {
      id: `split-${id}`, type: 'split', direction: id === 'a' ? 'vertical' : 'horizontal',
      children: sessions.filter(session => session.workspaceId === id)
        .map(session => ({ id: `pane-${session.id}`, type: 'pane', sessionId: session.id })),
    },
  })) as Workspace[];
  type DropHandler = ReturnType<typeof useTerminalWorkspaceLayout>['handleWorkspacePanePointerDrop'];
  type MoveHandler = Parameters<typeof useTerminalWorkspaceLayout>[0]['onMoveWorkspacePane'];
  const calls: Array<{ handler: string; args: Parameters<MoveHandler> }> = [];
  const firstHandler: MoveHandler = (...args) => calls.push({ handler: 'first', args });
  const secondHandler: MoveHandler = (...args) => calls.push({ handler: 'second', args });
  const noop = () => {};
  const keepHidden = () => true;
  const renders = new Map<string, number>();
  const Pane = memo(function Pane({ session, onDrop }: { session: TerminalSession; onDrop: DropHandler }) {
    renders.set(session.id, (renders.get(session.id) ?? 0) + 1);
    return React.createElement('button', { onClick: () => onDrop(session.id, { clientX: 0, clientY: 0 }) });
  });
  let layout!: ReturnType<typeof useTerminalWorkspaceLayout>;
  function Harness({ activeId, magnified = false, onMove = firstHandler }: {
    activeId: string; magnified?: boolean; onMove?: MoveHandler;
  }) {
    layout = useTerminalWorkspaceLayout({
      activeSession: undefined, activeWorkspace: workspaces.find(workspace => workspace.id === activeId),
      isFocusMode: false, hasMagnifiedPane: magnified,
      shouldKeepHiddenWorkspaceLaidOut: keepHidden,
      onAddSessionToWorkspace: noop, onCreateWorkspaceFromSessions: noop,
      onMoveWorkspacePane: onMove, draggingSession: null,
      onSetDraggingSessionId: noop, onUpdateSplitSizes: noop, sessions, workspaces,
    });
    // Like TerminalPanesHost, retain every pane while the active tab changes.
    // Ordinary memo compares onDrop; ignoring it would hide the regression.
    return React.createElement(React.Fragment, null, sessions.map(session => React.createElement(Pane, {
      key: session.id, session, onDrop: layout.handleWorkspacePanePointerDrop,
    })));
  }
  const render = (activeId: string, magnified = false, onMove = firstHandler) =>
    React.createElement(Harness, { activeId, magnified, onMove });
  await act(async () => { renderer = create(render('a')); });
  let size = { width: 1000, height: 500 };
  layout.workspaceInnerRef.current = {
    getBoundingClientRect: () => ({ left: 0, top: 0, ...size }),
  } as HTMLDivElement;
  await act(async () => layout.setWorkspaceArea(size));
  const savedDrop = layout.handleWorkspacePanePointerDrop;
  const initialRenders = [...renders];
  await act(async () => renderer!.update(render('b')));
  await act(async () => renderer!.update(render('a')));
  assert.deepEqual([...renders], initialRenders, 'A -> B -> A must not repaint mounted hidden panes for a callback change');
  assert.equal(layout.handleWorkspacePanePointerDrop, savedDrop);

  await act(async () => renderer!.update(render('b')));
  await act(async () => savedDrop('a1', { clientX: 800, clientY: 400 }));
  assert.equal(calls.length, 0, 'an old gesture cannot move a pane from the inactive workspace');
  await act(async () => savedDrop('b1', { clientX: 800, clientY: 400 }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { handler: 'first', args: ['b', 'b1', {
    direction: 'vertical', position: 'right', targetSessionId: 'b2',
    rect: { x: 500, y: 250, w: 500, h: 250 },
  }] });

  await act(async () => renderer!.update(render('b', true, secondHandler)));
  await act(async () => savedDrop('b1', { clientX: 800, clientY: 400 }));
  assert.equal(calls.length, 1, 'the saved callback honors current magnification');
  size = { width: 2000, height: 1000 };
  await act(async () => layout.setWorkspaceArea(size));
  await act(async () => renderer!.update(render('b', false, secondHandler)));
  await act(async () => savedDrop('b1', { clientX: 1600, clientY: 800 }));
  assert.deepEqual(calls[1], { handler: 'second', args: ['b', 'b1', {
    direction: 'vertical', position: 'right', targetSessionId: 'b2',
    rect: { x: 1000, y: 500, w: 1000, h: 500 },
  }] });
  assert.equal(layout.handleWorkspacePanePointerDrop, savedDrop);
  assert.deepEqual([...renders], initialRenders, 'layout and handler changes also retain the stable pane callback');
});
