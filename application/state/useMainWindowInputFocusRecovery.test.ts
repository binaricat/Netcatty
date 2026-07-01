import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startMainWindowInputFocusRecovery } from "./useMainWindowInputFocusRecovery.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

type Listener = () => void;

function createEventTargetStub() {
  const listeners = new Map<string, Set<Listener>>();

  return {
    addEventListener(eventName: string, listener: Listener) {
      const eventListeners = listeners.get(eventName) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(eventName, eventListeners);
    },
    removeEventListener(eventName: string, listener: Listener) {
      listeners.get(eventName)?.delete(listener);
    },
    dispatch(eventName: string) {
      for (const listener of listeners.get(eventName) ?? []) {
        listener();
      }
    },
    listenerCount(eventName: string) {
      return listeners.get(eventName)?.size ?? 0;
    },
  };
}

test("main-window input focus recovery ignores generic focus and visible visibility changes", () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let scheduleFocusCalls = 0;
  let cancelFocusCalls = 0;
  let hiddenCalls = 0;
  let shownHandler: Listener | null = null;
  let willHideHandler: Listener | null = null;

  const documentTarget = createEventTargetStub();
  const windowTarget = createEventTargetStub();

  const cleanup = startMainWindowInputFocusRecovery(
    { onPageHidden: () => { hiddenCalls += 1; } },
    {
      documentRef: {
        ...documentTarget,
        get visibilityState() {
          return visibilityState;
        },
      },
      windowRef: windowTarget,
      bridge: {
        onWindowShown(cb: Listener) {
          shownHandler = cb;
          return () => { shownHandler = null; };
        },
        onWindowWillHide(cb: Listener) {
          willHideHandler = cb;
          return () => { willHideHandler = null; };
        },
      },
      scheduleFocus: () => {
        scheduleFocusCalls += 1;
        return { cancel: () => { cancelFocusCalls += 1; } };
      },
    },
  );

  assert.equal(windowTarget.listenerCount("focus"), 0);

  windowTarget.dispatch("focus");
  documentTarget.dispatch("visibilitychange");

  assert.equal(scheduleFocusCalls, 0);
  assert.equal(hiddenCalls, 0);

  shownHandler?.();

  assert.equal(scheduleFocusCalls, 1);

  willHideHandler?.();

  assert.equal(hiddenCalls, 1);
  assert.equal(cancelFocusCalls, 1);

  shownHandler?.();

  assert.equal(scheduleFocusCalls, 2);

  visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");

  assert.equal(hiddenCalls, 2);
  assert.equal(cancelFocusCalls, 2);

  cleanup();
});

test("main-window input focus recovery retries an explicit show when visibility catches up", () => {
  let visibilityState: DocumentVisibilityState = "hidden";
  let scheduleFocusCalls = 0;
  let hiddenCalls = 0;
  let shownHandler: Listener | null = null;

  const documentTarget = createEventTargetStub();

  const cleanup = startMainWindowInputFocusRecovery(
    { onPageHidden: () => { hiddenCalls += 1; } },
    {
      documentRef: {
        ...documentTarget,
        get visibilityState() {
          return visibilityState;
        },
      },
      bridge: {
        onWindowShown(cb: Listener) {
          shownHandler = cb;
          return () => { shownHandler = null; };
        },
      },
      scheduleFocus: () => {
        scheduleFocusCalls += 1;
        return { cancel: () => undefined };
      },
    },
  );

  shownHandler?.();

  assert.equal(scheduleFocusCalls, 0);

  visibilityState = "visible";
  documentTarget.dispatch("visibilitychange");

  assert.equal(scheduleFocusCalls, 1);
  assert.equal(hiddenCalls, 0);

  documentTarget.dispatch("visibilitychange");

  assert.equal(scheduleFocusCalls, 1);

  cleanup();
});

test("useMainWindowInputFocusRecovery restores input focus only after explicit window-shown IPC", () => {
  const source = readProjectFile("application/state/useMainWindowInputFocusRecovery.ts");

  assert.match(source, /visibilityState !== "visible"/);
  assert.match(source, /scheduleFocus\(\)/);
  assert.match(source, /onWindowShown\?\.\(\(\) => \{\s*pendingExplicitShowRecovery = true;\s*recoverFocus\(\);\s*\}\)/);
  assert.doesNotMatch(source, /window\.addEventListener\("focus"/);
  assert.doesNotMatch(source, /window\.removeEventListener\("focus"/);
});

test("useMainWindowInputFocusRecovery uses visibility changes only to dismiss transient UI", () => {
  const source = readProjectFile("application/state/useMainWindowInputFocusRecovery.ts");
  const handlerStart = source.indexOf("const onVisibilityChange");
  const handlerEnd = source.indexOf('addEventListener("visibilitychange"', handlerStart);
  const visibilityHandler = source.slice(handlerStart, handlerEnd);

  assert.match(source, /visibilityState === "hidden"/);
  assert.match(source, /addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.match(source, /onPageHidden\?\.\(\)/);
  assert.match(source, /onWindowWillHide/);
  assert.match(source, /cancelPendingFocusRecovery/);
  assert.match(visibilityHandler, /dismissTransientUi\(\)/);
  assert.doesNotMatch(visibilityHandler, /else\s*\{\s*recoverFocus\(\);\s*\}/);
  assert.doesNotMatch(visibilityHandler, /visibilityState !== "hidden"[\s\S]*recoverFocus\(\)/);
});

test("scheduleWindowInputFocus skips deferred focus when the page is hidden", () => {
  const source = readProjectFile("application/state/windowInputFocus.ts");

  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /cancelAnimationFrame/);
  assert.match(source, /clearTimeout/);
});

test("AppView mounts main-window input focus recovery with overlay dismiss", () => {
  const source = readProjectFile("application/app/AppView.tsx");

  assert.match(source, /useMainWindowInputFocusRecovery\(\{ onPageHidden: dismissTransientOverlays \}\)/);
  assert.match(source, /setIsQuickSwitcherOpen\(false\)/);
  assert.match(source, /setProtocolSelectHost\(null\)/);
});

test("dropdown closes when the document becomes hidden", () => {
  const source = readProjectFile("components/ui/dropdown.tsx");

  assert.match(source, /document\.visibilityState === "hidden"/);
  assert.match(source, /setOpen\(false\)/);
});
