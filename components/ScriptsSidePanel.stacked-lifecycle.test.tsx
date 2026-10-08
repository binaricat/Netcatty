import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createDomRenderer, dispatchDomEvent, installDomEnvironment, runWithAct } from "./test-support/renderReactDom.tsx";
import type { Snippet } from "../types";

test("stacked library continues loading after running a script and returning", async (t) => {
  const env = installDomEnvironment();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: env.window.localStorage });
  const observers: Array<{ target: Element | null; intersect: () => void }> = [];
  class Observer {
    target: Element | null = null;
    constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
    observe(target: Element) { this.target = target; }
    disconnect() { this.target = null; }
    intersect = () => {
      if (this.target?.isConnected) {
        this.callback([{ target: this.target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    };
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer });
  const { ScriptsSidePanel } = await import("./ScriptsSidePanel.tsx");
  const { I18nProvider } = await import("../application/i18n/I18nProvider.tsx");
  const { SCRIPTS_VIEW_MODE_STORAGE_KEY } = await import("../application/state/useScriptsViewMode.ts");
  env.window.localStorage.setItem(SCRIPTS_VIEW_MODE_STORAGE_KEY, "stacked");
  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
    else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    env.cleanup();
  });
  const snippets: Snippet[] = Array.from({ length: 300 }, (_, i) => ({
    id: `script-${i}`, label: `Script ${String(i).padStart(3, "0")}`, command: "echo ok", kind: "script", package: "",
  }));
  const executed: string[] = [];
  await renderer.render(
    <I18nProvider locale="en"><ScriptsSidePanel snippets={snippets} packages={[]}
      onSnippetClick={() => assert.fail("scripts use the existing script execution path")}
      onRunScript={(snippet) => executed.push(snippet.id)} /></I18nProvider>,
  );
  const library = () => env.document.querySelector('[data-scripts-view="stacked"]');
  const chipCount = () => library()?.querySelectorAll("button").length;
  const button = (label: string) => {
    const result = Array.from(env.document.querySelectorAll("button")).find((element) => element.textContent === label);
    assert.ok(result, `missing button ${label}`);
    return result;
  };
  assert.equal(chipCount(), 120);
  const firstSentinel = observers.at(-1)?.target;
  assert.ok(firstSentinel?.isConnected);
  await dispatchDomEvent(button("Script 000"), new env.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(executed, ["script-0"]);
  assert.equal(library(), null, "execution opens Running");
  assert.equal(firstSentinel.isConnected, false);
  await dispatchDomEvent(button("Library"), new env.window.MouseEvent("click", { bubbles: true }));
  assert.equal(chipCount(), 120);
  assert.ok(observers.at(-1)?.target?.isConnected, "the new sentinel must be observed");
  assert.notEqual(observers.at(-1)?.target, firstSentinel);
  await runWithAct(() => { observers.at(-1)?.intersect(); });
  assert.equal(chipCount(), 240);
  await dispatchDomEvent(button("Running"), new env.window.MouseEvent("click", { bubbles: true }));
  await dispatchDomEvent(button("Library"), new env.window.MouseEvent("click", { bubbles: true }));
  assert.equal(chipCount(), 240, "returning preserves the loaded window");
  await runWithAct(() => { observers.at(-1)?.intersect(); });
  assert.equal(chipCount(), 300);
  assert.ok(button("Script 299"));
});
