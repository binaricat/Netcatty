import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../Terminal" && context.parentURL?.endsWith("/TerminalLayerSupport.tsx")) {
      return {
        url: "data:text/javascript,export default function Terminal(){return null}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", source: "export default {};", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { useWorkspaceDetachPointerDrag } = await import("./TerminalLayerSupport");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type Listener = EventListenerOrEventListenerObject;

function createDragDom() {
  const documentListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  const appendedElements = new Set<{ remove: () => void }>();

  const addListener = (listeners: Map<string, Set<Listener>>, type: string, listener: Listener) => {
    const entries = listeners.get(type) ?? new Set<Listener>();
    entries.add(listener);
    listeners.set(type, entries);
  };
  const removeListener = (listeners: Map<string, Set<Listener>>, type: string, listener: Listener) => {
    listeners.get(type)?.delete(listener);
  };
  const dispatch = (listeners: Map<string, Set<Listener>>, type: string, event: Event) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  };

  const fakeWindow = {
    addEventListener: (type: string, listener: Listener) => addListener(windowListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) => removeListener(windowListeners, type, listener),
  };
  const fakeDocument = {
    body: {
      appendChild: (element: { remove: () => void }) => appendedElements.add(element),
    },
    createElement: () => {
      const element = {
        style: {} as Record<string, string>,
        textContent: "",
        remove: () => appendedElements.delete(element),
      };
      return element;
    },
    querySelector: () => null,
    addEventListener: (type: string, listener: Listener) => addListener(documentListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) => removeListener(documentListeners, type, listener),
    defaultView: fakeWindow,
  };

  return {
    document: fakeDocument as unknown as Document,
    documentListenerCount: (type: string) => documentListeners.get(type)?.size ?? 0,
    windowListenerCount: (type: string) => windowListeners.get(type)?.size ?? 0,
    dispatchDocument: (type: string, event: Event) => dispatch(documentListeners, type, event),
    dispatchWindow: (type: string, event: Event) => dispatch(windowListeners, type, event),
    appendedElements,
  };
}

test("pointer drag cleanup runs when the pane unmounts without pointerup", async () => {
  const dom = createDragDom();
  let pointerDown: ((event: React.PointerEvent<HTMLElement>) => void) | null = null;
  let dragStartCount = 0;
  let dragEndCount = 0;

  function Harness() {
    pointerDown = useWorkspaceDetachPointerDrag({
      inActiveWorkspace: true,
      session: { id: "session-1", workspaceId: "workspace-1" } as never,
      onStartSessionDrag: () => { dragStartCount += 1; },
      onEndSessionDrag: () => { dragEndCount += 1; },
    });
    return null;
  }

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });

  const pointerTarget = { ownerDocument: dom.document };
  await act(async () => {
    pointerDown!({
      button: 0,
      clientX: 0,
      clientY: 0,
      currentTarget: pointerTarget,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    } as unknown as React.PointerEvent<HTMLElement>);
  });

  assert.equal(dom.documentListenerCount("pointermove"), 1);
  assert.equal(dom.documentListenerCount("pointerup"), 1);
  assert.equal(dom.documentListenerCount("pointercancel"), 1);
  assert.equal(dom.windowListenerCount("blur"), 1);
  assert.equal(dom.appendedElements.size, 0);
  assert.equal(dragStartCount, 0);

  await act(async () => {
    renderer!.unmount();
  });

  assert.equal(dom.documentListenerCount("pointermove"), 0);
  assert.equal(dom.documentListenerCount("pointerup"), 0);
  assert.equal(dom.documentListenerCount("pointercancel"), 0);
  assert.equal(dom.windowListenerCount("blur"), 0);
  assert.equal(dom.appendedElements.size, 0);
  assert.equal(dragEndCount, 0);
});

test("unmount removes an active drag overlay and ends drag state", async () => {
  const dom = createDragDom();
  let pointerDown: ((event: React.PointerEvent<HTMLElement>) => void) | null = null;
  let dragStartCount = 0;
  let dragEndCount = 0;

  function Harness() {
    pointerDown = useWorkspaceDetachPointerDrag({
      inActiveWorkspace: true,
      session: { id: "session-1", workspaceId: "workspace-1" } as never,
      onStartSessionDrag: () => { dragStartCount += 1; },
      onEndSessionDrag: () => { dragEndCount += 1; },
    });
    return null;
  }

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });
  await act(async () => {
    pointerDown!({
      button: 0,
      clientX: 0,
      clientY: 0,
      currentTarget: { ownerDocument: dom.document },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    } as unknown as React.PointerEvent<HTMLElement>);
    dom.dispatchDocument("pointermove", { clientX: 10, clientY: 10 } as PointerEvent);
  });

  assert.equal(dom.appendedElements.size, 2);
  assert.equal(dragStartCount, 1);

  await act(async () => {
    renderer!.unmount();
  });

  assert.equal(dom.documentListenerCount("pointermove"), 0);
  assert.equal(dom.documentListenerCount("pointerup"), 0);
  assert.equal(dom.documentListenerCount("pointercancel"), 0);
  assert.equal(dom.windowListenerCount("blur"), 0);
  assert.equal(dom.appendedElements.size, 0);
  assert.equal(dragEndCount, 1);
});

test("all pointer drag exit paths share one idempotent cleanup", async () => {
  const dom = createDragDom();
  let pointerDown: ((event: React.PointerEvent<HTMLElement>) => void) | null = null;
  let dragStartCount = 0;
  let dragEndCount = 0;

  function Harness() {
    pointerDown = useWorkspaceDetachPointerDrag({
      inActiveWorkspace: true,
      session: { id: "session-1", workspaceId: "workspace-1" } as never,
      onStartSessionDrag: () => { dragStartCount += 1; },
      onEndSessionDrag: () => { dragEndCount += 1; },
    });
    return null;
  }

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });

  const beginDrag = () => {
    pointerDown!({
      button: 0,
      clientX: 0,
      clientY: 0,
      currentTarget: { ownerDocument: dom.document },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    } as unknown as React.PointerEvent<HTMLElement>);
    dom.dispatchDocument("pointermove", { clientX: 10, clientY: 10 } as PointerEvent);
  };
  const assertClean = () => {
    assert.equal(dom.documentListenerCount("pointermove"), 0);
    assert.equal(dom.documentListenerCount("pointerup"), 0);
    assert.equal(dom.documentListenerCount("pointercancel"), 0);
    assert.equal(dom.windowListenerCount("blur"), 0);
    assert.equal(dom.appendedElements.size, 0);
  };

  await act(async () => {
    beginDrag();
    dom.dispatchDocument("pointercancel", {} as PointerEvent);
  });
  assertClean();
  assert.equal(dragStartCount, 1);
  assert.equal(dragEndCount, 1);

  await act(async () => {
    beginDrag();
    beginDrag();
  });
  assert.equal(dragStartCount, 3);
  assert.equal(dragEndCount, 2, "starting again must clean the previous drag exactly once");
  assert.equal(dom.documentListenerCount("pointermove"), 1);
  assert.equal(dom.appendedElements.size, 2);

  await act(async () => {
    dom.dispatchWindow("blur", {} as Event);
  });
  assertClean();
  assert.equal(dragEndCount, 3);

  await act(async () => {
    beginDrag();
    dom.dispatchDocument("pointerup", { clientX: 10, clientY: 10 } as PointerEvent);
  });
  assertClean();
  assert.equal(dragStartCount, 4);
  assert.equal(dragEndCount, 4);

  await act(async () => {
    renderer!.unmount();
  });
  assert.equal(dragEndCount, 4, "unmount after cleanup must not end the drag twice");
});
