import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleChromeLayoutAnimation,
  syncActiveChromeTheme,
  themeFingerprint,
} from "./useActiveChromeTheme.ts";
import { TERMINAL_THEMES } from "../../infrastructure/config/terminalThemes.ts";
import { readFileSync } from "node:fs";

function createInlineStyle() {
  const values = new Map<string, string>();
  return {
    getPropertyValue: (name: string) => values.get(name) ?? "",
    setProperty: (name: string, value: string) => values.set(name, value),
    removeProperty: (name: string) => values.delete(name),
  };
}

function createRafRoot() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const view = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      callbacks.delete(id);
    },
  };
  const root = {
    ownerDocument: { defaultView: view },
  } as unknown as HTMLElement;

  const flushFrame = () => {
    const [id, callback] = callbacks.entries().next().value ?? [];
    if (!id || !callback) return false;
    callbacks.delete(id);
    callback(0);
    return true;
  };

  return { root, flushFrame };
}

test("chrome layout animations wait until theme settle frames complete", () => {
  const { root, flushFrame } = createRafRoot();
  let ran = false;

  const cancel = scheduleChromeLayoutAnimation(() => {
    ran = true;
  }, root);

  while (!ran && flushFrame()) {
    // Drain scheduled animation frames.
  }
  assert.equal(ran, true);
  cancel();
});

test("syncActiveChromeTheme skips surface refresh when the active theme fingerprint is unchanged", () => {
  const globalWithDocument = globalThis as typeof globalThis & { document?: Document };
  const originalDocument = globalWithDocument.document;
  const theme = TERMINAL_THEMES[0];
  assert.ok(theme);
  const topTabsRoot = {
    style: createInlineStyle(),
  };
  const documentElement = {
    dataset: { activeChromeTheme: themeFingerprint(theme) },
  };
  const fakeDocument = {
    documentElement,
    querySelector: (selector: string) => selector === "[data-top-tabs-root]" ? topTabsRoot : null,
  };
  globalWithDocument.document = fakeDocument as unknown as Document;

  try {
    syncActiveChromeTheme(theme, () => {
      throw new Error("app theme should not be restored for an unchanged active chrome theme");
    });

    assert.equal(topTabsRoot.style.getPropertyValue("--top-tabs-bg"), "");
    assert.equal(topTabsRoot.style.getPropertyValue("--top-tabs-active-bg"), "");
    assert.equal(topTabsRoot.style.getPropertyValue("--top-tabs-accent"), "");
  } finally {
    if (originalDocument) {
      globalWithDocument.document = originalDocument;
    } else {
      delete globalWithDocument.document;
    }
  }
});

test("active chrome theme foreground uses contrast calculation", () => {
  const source = readFileSync(new URL("./useActiveChromeTheme.ts", import.meta.url), "utf8");

  assert.match(source, /resolveReadableForegroundForHsl\(cursor\)/);
  assert.doesNotMatch(source, /cursorLightness > 55/);
});
