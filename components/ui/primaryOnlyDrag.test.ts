import assert from "node:assert/strict";
import test from "node:test";

import {
  primaryOnlyDragHandlers,
  restorePrimaryOnlyDrag,
} from "./primaryOnlyDrag.ts";

const fakeRoot = () => {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    listeners,
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string) {
      for (const listener of Array.from(listeners.get(type) ?? [])) {
        listener(new Event(type));
      }
    },
  };
};

test("primaryOnlyDragHandlers restores draggable after a right-click is released outside", () => {
  const root = fakeRoot();
  const target = { draggable: true } as HTMLElement;
  const handlers = primaryOnlyDragHandlers(true, root);

  handlers.onPointerDown({
    button: 2,
    currentTarget: target,
  } as Parameters<typeof handlers.onPointerDown>[0]);

  assert.equal(target.draggable, false);
  assert.equal(root.listeners.get("pointerup")?.size, 1);
  assert.equal(root.listeners.get("pointercancel")?.size, 1);

  root.dispatch("pointerup");

  assert.equal(target.draggable, true);
  assert.equal(root.listeners.get("pointerup")?.size, 0);
  assert.equal(root.listeners.get("pointercancel")?.size, 0);
});

test("primaryOnlyDragHandlers pointercancel on the document also restores draggable", () => {
  const root = fakeRoot();
  const target = { draggable: true } as HTMLElement;
  const handlers = primaryOnlyDragHandlers(true, root);

  handlers.onPointerDown({
    button: 2,
    currentTarget: target,
  } as Parameters<typeof handlers.onPointerDown>[0]);
  root.dispatch("pointercancel");

  assert.equal(target.draggable, true);
  assert.equal(root.listeners.get("pointerup")?.size, 0);
  assert.equal(root.listeners.get("pointercancel")?.size, 0);
});

test("element-level pointerup clears the document restore listeners", () => {
  const root = fakeRoot();
  const target = { draggable: true } as HTMLElement;
  const handlers = primaryOnlyDragHandlers(true, root);

  handlers.onPointerDown({
    button: 2,
    currentTarget: target,
  } as Parameters<typeof handlers.onPointerDown>[0]);
  handlers.onPointerUp({
    currentTarget: target,
  } as Parameters<typeof handlers.onPointerUp>[0]);

  assert.equal(target.draggable, true);
  assert.equal(root.listeners.get("pointerup")?.size, 0);
  restorePrimaryOnlyDrag(target, false);
  assert.equal(target.draggable, false);
});

test("primary pointer down does not disable dragging", () => {
  const root = fakeRoot();
  const target = { draggable: true } as HTMLElement;
  const handlers = primaryOnlyDragHandlers(true, root);

  handlers.onPointerDown({
    button: 0,
    currentTarget: target,
  } as Parameters<typeof handlers.onPointerDown>[0]);

  assert.equal(target.draggable, true);
  assert.equal(root.listeners.get("pointerup")?.size ?? 0, 0);
});
