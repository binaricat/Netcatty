import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./snippets/SnippetScriptEditor"
      && context.parentURL?.endsWith("/QuickAddSnippetDialog.tsx")
    ) {
      return {
        url: "data:text/javascript,export function SnippetScriptEditor(){return null}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const source = readFileSync(new URL("./QuickAddSnippetDialog.tsx", import.meta.url), "utf8");
const recorderSource = readFileSync(
  new URL("../application/state/useSnippetShortkeyRecorder.ts", import.meta.url),
  "utf8",
);

test("QuickAddSnippetDialog blocks shortkey recording while app lock overlay is active", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;
  const prevKeyboardEvent = globalThis.KeyboardEvent;
  const prevCustomEvent = globalThis.CustomEvent;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevHTMLInputElement = globalThis.HTMLInputElement;
  const prevElement = globalThis.Element;
  const prevNode = globalThis.Node;
  const prevNodeFilter = globalThis.NodeFilter;
  const prevDocumentFragment = globalThis.DocumentFragment;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = env.IS_REACT_ACT_ENVIRONMENT;

  env.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "KeyboardEvent", { value: dom.window.KeyboardEvent, configurable: true });
  Object.defineProperty(globalThis, "CustomEvent", { value: dom.window.CustomEvent, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "HTMLInputElement", { value: dom.window.HTMLInputElement, configurable: true });
  Object.defineProperty(globalThis, "Element", { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true });
  Object.defineProperty(globalThis, "NodeFilter", { value: dom.window.NodeFilter, configurable: true });
  Object.defineProperty(globalThis, "DocumentFragment", { value: dom.window.DocumentFragment, configurable: true });
  Object.defineProperty(globalThis, "MutationObserver", { value: dom.window.MutationObserver, configurable: true });
  Object.defineProperty(globalThis, "getComputedStyle", { value: dom.window.getComputedStyle.bind(dom.window), configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: (id: number) => clearTimeout(id),
    configurable: true,
  });

  // Import after installing DOM globals so React DOM and Radix Portal see the browser environment.
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const { default: QuickAddSnippetDialog } = await import("./QuickAddSnippetDialog.tsx");

  let root: Root | undefined;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <QuickAddSnippetDialog
              snippets={[]}
              packages={[]}
              hotkeyScheme="pc"
              keyBindings={[]}
              onCreateSnippet={() => {}}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.CustomEvent("netcatty:snippets:add", { detail: { command: "pwd" } }));
    });

    const recordButton = dom.window.document.querySelector<HTMLButtonElement>("button[aria-pressed]");
    assert.ok(recordButton, "expected shortkey record button inside open QuickAddSnippetDialog");

    await act(async () => {
      recordButton.click();
    });
    assert.equal(recordButton.getAttribute("aria-pressed"), "true");

    const lockOverlay = dom.window.document.createElement("div");
    lockOverlay.setAttribute("data-app-lock-overlay", "true");
    dom.window.document.body.appendChild(lockOverlay);

    const lockedEvent = new dom.window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(lockedEvent);
    });
    assert.equal(lockedEvent.defaultPrevented, false);
    assert.equal(recordButton.getAttribute("aria-pressed"), "true");
    assert.doesNotMatch(recordButton.textContent ?? "", /Ctrl \+ Shift \+ K/);

    lockOverlay.remove();

    const unlockedEvent = new dom.window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(unlockedEvent);
    });
    assert.equal(unlockedEvent.defaultPrevented, true);
    assert.equal(recordButton.getAttribute("aria-pressed"), "false");
    assert.match(recordButton.textContent ?? "", /Ctrl \+ Shift \+ K/);
  } finally {
    await act(async () => {
      root?.unmount();
      // Radix schedules focus cleanup after unmount. Let it run while the
      // JSDOM globals are still installed; restoring them first makes a
      // deferred dispatch mix JSDOM and Node event classes.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    env.IS_REACT_ACT_ENVIRONMENT = prevAct;
    Object.defineProperty(globalThis, "window", { value: prevWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: prevDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
    Object.defineProperty(globalThis, "KeyboardEvent", { value: prevKeyboardEvent, configurable: true });
    Object.defineProperty(globalThis, "CustomEvent", { value: prevCustomEvent, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: prevHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "HTMLInputElement", { value: prevHTMLInputElement, configurable: true });
    Object.defineProperty(globalThis, "Element", { value: prevElement, configurable: true });
    Object.defineProperty(globalThis, "Node", { value: prevNode, configurable: true });
    Object.defineProperty(globalThis, "NodeFilter", { value: prevNodeFilter, configurable: true });
    Object.defineProperty(globalThis, "DocumentFragment", { value: prevDocumentFragment, configurable: true });
    Object.defineProperty(globalThis, "MutationObserver", { value: prevMutationObserver, configurable: true });
    Object.defineProperty(globalThis, "getComputedStyle", { value: prevGetComputedStyle, configurable: true });
    Object.defineProperty(globalThis, "requestAnimationFrame", { value: prevRaf, configurable: true });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { value: prevCancelRaf, configurable: true });
    dom.window.close();
  }
});

test("quick add snippet event can prefill command", async () => {
  const { getQuickAddSnippetInitialCommand } = await import("./QuickAddSnippetDialog.tsx");
  const event = {
    detail: { command: "ls -la\npwd" },
  } as CustomEvent<{ command?: string }>;

  assert.equal(getQuickAddSnippetInitialCommand(event), "ls -la\npwd");
});

test("quick add snippet event defaults to an empty command", async () => {
  const { getQuickAddSnippetInitialCommand } = await import("./QuickAddSnippetDialog.tsx");
  assert.equal(getQuickAddSnippetInitialCommand({} as Event), "");
  assert.equal(
    getQuickAddSnippetInitialCommand({
      detail: { command: 123 },
    } as unknown as Event),
    "",
  );
});

test("quick add snippet form binds shortkeys and uses a centered Dialog modal", () => {
  assert.match(source, /DialogContent/);
  assert.match(source, /from '\.\/ui\/dialog'/);
  assert.doesNotMatch(source, /AsidePanel/);
  assert.match(source, /snippets\.field\.shortkey/);
  assert.match(source, /useSnippetShortkeyRecorder/);
  assert.match(recorderSource, /findActiveSystemShortcutConflict/);
  assert.match(recorderSource, /keyEventToString/);
  assert.match(source, /shortkey: shortkey \|\| undefined/);
  assert.match(source, /if \(e\.defaultPrevented\) return/);
  // Escape while recording a shortkey cancels capture instead of closing
  assert.match(source, /onEscapeKeyDown/);
  assert.match(source, /isRecordingShortkey/);
  // Pointer dismissals must close even while recording (no stale-recording gate)
  assert.doesNotMatch(
    source,
    /if\s*\(\s*isRecordingShortkey\s*\)\s*\{\s*setIsRecordingShortkey\(false\);\s*setShortkeyError\(null\);\s*return;/,
  );
});

test("shared Dialog exposes data-dialog-close for Cmd+W / hasOpenAppDialog", () => {
  const dialogSource = readFileSync(new URL("./ui/dialog.tsx", import.meta.url), "utf8");
  assert.match(dialogSource, /data-dialog-close="true"/);
});
