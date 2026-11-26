import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { KeyBinding, Snippet } from "../../domain/models.ts";
import { useSnippetShortkeyRecorder } from "./useSnippetShortkeyRecorder.ts";

const makeSnippet = (id: string, label: string, shortkey?: string): Snippet => ({
  id,
  label,
  command: `echo ${id}`,
  tags: [],
  package: "",
  targets: [],
  shortkey,
});

const stubT = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => {
  if (!values) return key;
  return `${key}:${JSON.stringify(values)}`;
};

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevKeyboardEvent = globalThis.KeyboardEvent;
  const prevNavigator = globalThis.navigator;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = env.IS_REACT_ACT_ENVIRONMENT;

  env.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "KeyboardEvent", { value: dom.window.KeyboardEvent, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  return {
    dom,
    cleanup() {
      env.IS_REACT_ACT_ENVIRONMENT = prevAct;
      Object.defineProperty(globalThis, "window", { value: prevWindow, configurable: true });
      Object.defineProperty(globalThis, "document", { value: prevDocument, configurable: true });
      Object.defineProperty(globalThis, "KeyboardEvent", { value: prevKeyboardEvent, configurable: true });
      Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
      dom.window.close();
    },
  };
}

test("useSnippetShortkeyRecorder captures valid shortkeys, ignores modifiers, and cancels on Escape", async () => {
  const { dom, cleanup } = installDom();
  const captured: string[] = [];
  let latest!: ReturnType<typeof useSnippetShortkeyRecorder>;

  function Harness() {
    latest = useSnippetShortkeyRecorder({
      snippets: [],
      hotkeyScheme: "pc",
      keyBindings: [],
      t: stubT,
      onCapture: (key) => captured.push(key),
    });
    return null;
  }

  let root: Root | undefined;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      latest.setIsRecordingShortkey(true);
    });
    assert.equal(latest.isRecordingShortkey, true);

    // Modifier-only key press keeps recording active.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Control", ctrlKey: true, cancelable: true }));
    });
    assert.equal(latest.isRecordingShortkey, true);
    assert.deepEqual(captured, []);

    // Valid shortcut captures and stops recording.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true, cancelable: true }));
    });
    assert.equal(latest.isRecordingShortkey, false);
    assert.equal(latest.shortkeyError, null);
    assert.deepEqual(captured, ["Ctrl + Shift + K"]);

    // Escape cancels recording and clears error without capturing.
    await act(async () => {
      latest.setShortkeyError("some error");
      latest.setIsRecordingShortkey(true);
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    assert.equal(latest.isRecordingShortkey, false);
    assert.equal(latest.shortkeyError, null);
    assert.deepEqual(captured, ["Ctrl + Shift + K"]);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    cleanup();
  }
});

test("useSnippetShortkeyRecorder reports system and snippet conflicts while ignoring self", async () => {
  const { dom, cleanup } = installDom();
  const captured: string[] = [];
  let latest!: ReturnType<typeof useSnippetShortkeyRecorder>;

  const keyBindings: KeyBinding[] = [
    {
      id: "newTab",
      action: "newTab",
      label: "New Tab",
      mac: "\u2318 + T",
      pc: "Ctrl + T",
      category: "tabs",
    },
  ];
  const snippets: Snippet[] = [
    makeSnippet("snip-self", "Self Snippet", "Ctrl + Shift + S"),
    makeSnippet("snip-other", "Other Snippet", "Ctrl + Shift + O"),
  ];

  function Harness() {
    latest = useSnippetShortkeyRecorder({
      snippets,
      editingSnippetId: "snip-self",
      hotkeyScheme: "pc",
      keyBindings,
      t: stubT,
      onCapture: (key) => captured.push(key),
    });
    return null;
  }

  let root: Root | undefined;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      latest.setIsRecordingShortkey(true);
    });

    // Conflicts with system binding.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "t", ctrlKey: true, cancelable: true }));
    });
    assert.equal(latest.isRecordingShortkey, true);
    assert.match(latest.shortkeyError ?? "", /snippets\.shortkey\.error\.systemConflict/);
    assert.match(latest.shortkeyError ?? "", /New Tab/);

    // Conflicts with another snippet.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "o", ctrlKey: true, shiftKey: true, cancelable: true }));
    });
    assert.equal(latest.isRecordingShortkey, true);
    assert.match(latest.shortkeyError ?? "", /snippets\.shortkey\.error\.snippetConflict/);
    assert.match(latest.shortkeyError ?? "", /Other Snippet/);

    // Same shortcut as currently edited snippet is allowed.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, shiftKey: true, cancelable: true }));
    });
    assert.equal(latest.isRecordingShortkey, false);
    assert.equal(latest.shortkeyError, null);
    assert.deepEqual(captured, ["Ctrl + Shift + S"]);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    cleanup();
  }
});

test("useSnippetShortkeyRecorder ignores keydowns while app lock overlay is active", async () => {
  const { dom, cleanup } = installDom();
  const captured: string[] = [];
  let latest!: ReturnType<typeof useSnippetShortkeyRecorder>;

  function Harness() {
    latest = useSnippetShortkeyRecorder({
      snippets: [],
      hotkeyScheme: "pc",
      keyBindings: [],
      t: stubT,
      onCapture: (key) => captured.push(key),
    });
    return null;
  }

  let root: Root | undefined;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      latest.setIsRecordingShortkey(true);
    });

    const lockOverlay = dom.window.document.createElement("div");
    lockOverlay.setAttribute("data-app-lock-overlay", "true");
    dom.window.document.body.appendChild(lockOverlay);

    const lockedEvent = new dom.window.KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(lockedEvent);
    });
    assert.equal(lockedEvent.defaultPrevented, false);
    assert.equal(latest.isRecordingShortkey, true);
    assert.deepEqual(captured, []);

    // Removing the lock overlay restores normal capture.
    lockOverlay.remove();
    const unlockedEvent = new dom.window.KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(unlockedEvent);
    });
    assert.equal(unlockedEvent.defaultPrevented, true);
    assert.equal(latest.isRecordingShortkey, false);
    assert.deepEqual(captured, ["Ctrl + P"]);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    cleanup();
  }
});
