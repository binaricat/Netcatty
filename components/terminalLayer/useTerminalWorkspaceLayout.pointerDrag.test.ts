import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React, { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { TerminalSession, Workspace } from '../../types';
import { useTerminalWorkspaceLayout } from './useTerminalWorkspaceLayout';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../Terminal' && context.parentURL?.endsWith('/TerminalLayerSupport.tsx')) {
      return { url: 'data:text/javascript,export default function Terminal(){return null}', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { useWorkspaceDetachPointerDrag } = await import('./TerminalLayerSupport');

type Listener = EventListenerOrEventListenerObject;

function eventSurface() {
  const listeners = new Map<string, Map<Listener, boolean>>();
  return {
    addEventListener(type: string, listener: Listener, capture = false) {
      const entries = listeners.get(type) ?? new Map<Listener, boolean>();
      entries.set(listener, capture);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: Listener, capture = false) {
      const entries = listeners.get(type);
      if (entries?.get(listener) === capture) entries.delete(listener);
    },
    dispatch(type: string, capture: boolean, event: PointerEvent) {
      for (const [listener, registeredCapture] of [...(listeners.get(type) ?? [])]) {
        if (registeredCapture !== capture) continue;
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

for (const scenario of ['move', 'release-only', 'self', 'cancel', 'blur', 'magnified', 'magnified-detach'] as const) {
test(`member pane gesture: ${scenario}`, async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const windowSurface = eventSurface();
  const documentSurface = eventSurface();
  const dragElements = new Set<object>();
  const ownerDocument = {
    ...documentSurface,
    defaultView: windowSurface,
    body: { appendChild: (element: object) => dragElements.add(element) },
    createElement: () => {
      const element = { style: {}, remove: () => dragElements.delete(element) };
      return element;
    },
    querySelector: () => scenario === 'magnified-detach' ? {
      getBoundingClientRect: () => ({ left: 0, right: 1000, top: -50, bottom: 0 }),
      querySelectorAll: () => [],
    } : null,
  } as unknown as Document;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowSurface });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let renderer: ReactTestRenderer | undefined;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  const sessions = [
    { id: 'pane-a', workspaceId: 'workspace' },
    { id: 'pane-b', workspaceId: 'workspace' },
  ] as TerminalSession[];
  const workspace = {
    id: 'workspace',
    root: {
      id: 'split', type: 'split', direction: 'vertical',
      children: sessions.map(session => ({ id: session.id, type: 'pane', sessionId: session.id })),
    },
  } as Workspace;
  const noop = () => {};
  const events: string[] = [];
  const moves: unknown[][] = [];
  const detachedIds: string[] = [];
  let hasMagnifiedPane = scenario === 'magnified' || scenario === 'magnified-detach';
  let pointerDown!: ReturnType<typeof useWorkspaceDetachPointerDrag>;
  let layout!: ReturnType<typeof useTerminalWorkspaceLayout>;
  function Harness() {
    const [draggingId, setDraggingId] = useState<string | null>(null);
    layout = useTerminalWorkspaceLayout({
      activeSession: undefined, activeWorkspace: workspace, isFocusMode: false,
      hasMagnifiedPane,
      shouldKeepHiddenWorkspaceLaidOut: () => false,
      onAddSessionToWorkspace: noop, onCreateWorkspaceFromSessions: noop,
      onMoveWorkspacePane: (...args) => { events.push('drop'); moves.push(args); },
      draggingSession: sessions.find(session => session.id === draggingId),
      onSetDraggingSessionId: setDraggingId, onUpdateSplitSizes: noop,
      sessions, workspaces: [workspace],
    });
    pointerDown = useWorkspaceDetachPointerDrag({
      inActiveWorkspace: true, session: sessions[0],
      onStartSessionDrag: id => { events.push('start'); setDraggingId(id); },
      onEndSessionDrag: () => { events.push('end'); setDraggingId(null); },
      onDropWorkspacePane: layout.handleWorkspacePanePointerDrop,
      onRemoveSessionFromWorkspace: id => { events.push('detach'); detachedIds.push(id); },
    });
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Harness)); });
  layout.workspaceInnerRef.current = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
  } as HTMLDivElement;
  await act(async () => layout.setWorkspaceArea({ width: 1000, height: 500 }));
  const destination = {
    clientX: scenario === 'self' ? 100 : 800,
    clientY: scenario === 'magnified-detach' ? -20 : 100,
  } as PointerEvent;
  await act(async () => {
    pointerDown({
      button: 0, clientX: 10, clientY: 10, currentTarget: { ownerDocument },
      preventDefault: noop, stopPropagation: noop,
    } as unknown as React.PointerEvent<HTMLElement>);
    if (scenario !== 'release-only') documentSurface.dispatch('pointermove', true, destination);
  });
  if (scenario !== 'release-only') {
    await act(async () => {
      windowSurface.dispatch('pointermove', true, destination);
      documentSurface.dispatch('pointermove', true, destination);
      windowSurface.dispatch('pointermove', false, destination);
    });
    assert.equal(layout.dropHint?.targetSessionId, scenario === 'self' || hasMagnifiedPane ? undefined : 'pane-b');
  }

  // Include a commit between native listener phases. Release must complete in
  // the gesture owner, even when no move was delivered before pointerup.
  const endingEvent = scenario === 'cancel' ? 'pointercancel' : 'pointerup';
  if (scenario === 'blur') {
    await act(async () => windowSurface.dispatch('blur', false, destination));
  } else {
    await act(async () => {
      windowSurface.dispatch(endingEvent, true, destination);
      documentSurface.dispatch(endingEvent, true, destination);
    });
    await act(async () => windowSurface.dispatch(endingEvent, false, destination));
  }

  const shouldDrop = scenario === 'move' || scenario === 'release-only';
  assert.deepEqual(events, shouldDrop ? ['start', 'drop', 'end']
    : scenario === 'magnified-detach' ? ['start', 'end', 'detach'] : ['start', 'end']);
  assert.deepEqual(moves, shouldDrop ? [['workspace', 'pane-a', {
    direction: 'horizontal', position: 'top', targetSessionId: 'pane-b',
    rect: { x: 500, y: 0, w: 500, h: 250 },
  }]] : []);
  assert.deepEqual(detachedIds, scenario === 'magnified-detach' ? ['pane-a'] : []);
  assert.equal(layout.dropHint, null);
  assert.equal(dragElements.size, 0);
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.equal(documentSurface.count(type), 0);
    assert.equal(windowSurface.count(type), 0);
  }

  if (scenario === 'magnified') {
    hasMagnifiedPane = false;
    await act(async () => renderer!.update(React.createElement(Harness)));
    await act(async () => {
      pointerDown({
        button: 0, clientX: 10, clientY: 10, currentTarget: { ownerDocument },
        preventDefault: noop, stopPropagation: noop,
      } as unknown as React.PointerEvent<HTMLElement>);
      documentSurface.dispatch('pointermove', true, destination);
    });
    await act(async () => windowSurface.dispatch('pointermove', false, destination));
    assert.equal(layout.dropHint?.targetSessionId, 'pane-b', 'restoring the tiled view restores preview');
    await act(async () => documentSurface.dispatch('pointerup', true, destination));
    assert.equal(moves.length, 1, 'restoring the tiled view permits exactly one move');
    assert.deepEqual(events, ['start', 'end', 'start', 'drop', 'end']);
    assert.equal(layout.dropHint, null);
  }
});
}
