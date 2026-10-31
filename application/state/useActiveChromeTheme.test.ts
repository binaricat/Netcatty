import assert from "node:assert/strict";
import test from "node:test";

import {
  CHROME_THEME_CSS_CACHE_MAX_ENTRIES,
  _cacheChromeThemeCssForTests,
  _getChromeThemeCssCacheStatsForTests,
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

// A hanging jsdom/React render must fail this test quickly instead of
// consuming the whole CI job budget.
test("terminal chrome never replaces the application native theme policy", { timeout: 15000 }, async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-top-tabs-root></div></body></html>');
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const themeSources: string[] = [];
  const backgrounds: string[] = [];
  const testWindow = dom.window as unknown as Window & typeof globalThis;
  testWindow.netcatty = {
    setTheme: async (source: string) => { themeSources.push(source); return true; },
    setBackgroundColor: async (background: string) => { backgrounds.push(background); return true; },
  } as unknown as NetcattyBridge;
  globalThis.window = testWindow;
  globalThis.document = testWindow.document;
  try {
    for (const type of ['light', 'dark'] as const) {
      const theme = TERMINAL_THEMES.find((candidate) => candidate.type === type);
      assert.ok(theme);
      syncActiveChromeTheme(theme, () => {});
      assert.equal(document.documentElement.classList.contains(type), true);
      assert.equal(backgrounds.at(-1), theme.colors.background);
    }
    assert.deepEqual(themeSources, [], 'terminal colors must not pin nativeTheme.themeSource to light/dark');
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    dom.window.close();
  }
});

test("system preference refresh reapplies an unchanged independent terminal chrome", { timeout: 15000 }, async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-top-tabs-root></div></body></html>');
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const backgrounds: string[] = [];
  const testWindow = dom.window as unknown as Window & typeof globalThis;
  testWindow.netcatty = {
    setTheme: async () => { throw new Error('chrome refresh must not change native theme policy'); },
    setBackgroundColor: async (background: string) => { backgrounds.push(background); return true; },
  } as unknown as NetcattyBridge;
  globalThis.window = testWindow;
  globalThis.document = testWindow.document;
  try {
    for (const type of ['light', 'dark'] as const) {
      const theme = TERMINAL_THEMES.find((candidate) => candidate.type === type);
      assert.ok(theme);
      syncActiveChromeTheme(theme, () => {});
      // The application settings effect runs first on an OS preference change.
      document.documentElement.className = type === 'dark' ? 'light' : 'dark';
      backgrounds.push('application-background');
      syncActiveChromeTheme(theme, () => {}, { refreshSurfaces: true });
      assert.equal(document.documentElement.classList.contains(type), true);
      assert.equal(backgrounds.at(-1), theme.colors.background);
    }
    syncActiveChromeTheme(null, () => {
      document.documentElement.className = 'light';
      backgrounds.push('application-background');
    });
    assert.equal(document.documentElement.className, 'light');
    assert.equal(document.documentElement.dataset.activeChromeTheme, undefined);
    assert.equal(document.getElementById('netcatty-active-chrome-theme'), null);
    assert.equal(backgrounds.at(-1), 'application-background');
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    dom.window.close();
  }
});

test("chrome hook reacts to OS preference changes with stable terminal props", { timeout: 15000 }, async () => {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useActiveChromeTheme } = await import('./useActiveChromeTheme');
  const { getSettingsChromeSnapshot, publishSettingsChromeSnapshot } = await import('./settingsChromeStore');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalSnapshot = getSettingsChromeSnapshot();
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const originalActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const backgrounds: string[] = [];
  const testWindow = dom.window as unknown as Window & typeof globalThis;
  globalThis.window = testWindow;
  globalThis.document = dom.window.document;
  testWindow.netcatty = {
    setBackgroundColor: async (color: string) => { backgrounds.push(color); return true; },
  } as unknown as NetcattyBridge;
  const theme = TERMINAL_THEMES.find((candidate) => candidate.type === 'dark');
  assert.ok(theme);
  const applyAppTheme = () => {};
  function Harness() {
    useActiveChromeTheme({ activeTheme: theme!, applyAppTheme });
    return null;
  }
  publishSettingsChromeSnapshot({ ...originalSnapshot, resolvedTheme: 'dark' });
  let renderer: ReturnType<typeof createRoot> | undefined;
  try {
    await act(async () => {
      renderer = createRoot(document.createElement('div'));
      renderer.render(createElement(Harness));
    });
    assert.equal(document.documentElement.classList.contains('dark'), true);
    document.documentElement.className = 'light';
    backgrounds.push('application-background');
    await act(async () => {
      publishSettingsChromeSnapshot({ ...originalSnapshot, resolvedTheme: 'light' });
    });
    assert.equal(document.documentElement.classList.contains('dark'), true);
    assert.equal(backgrounds.at(-1), theme.colors.background);
  } finally {
    await act(async () => { renderer?.unmount(); });
    environment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    publishSettingsChromeSnapshot(originalSnapshot);
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    dom.window.close();
  }
});

test("active chrome theme foreground uses contrast calculation", () => {
  const source = readFileSync(new URL("./useActiveChromeTheme.ts", import.meta.url), "utf8");

  assert.match(source, /resolveReadableForegroundForHsl\(cursor\)/);
  assert.doesNotMatch(source, /cursorLightness > 55/);
});

test("edited theme previews cannot grow the chrome CSS cache without bound", () => {
  const base = TERMINAL_THEMES[0];
  assert.ok(base);
  let latestFingerprint = "";
  for (let index = 0; index < CHROME_THEME_CSS_CACHE_MAX_ENTRIES * 2; index += 1) {
    const theme = {
      ...base,
      id: `edited-preview-${index}`,
      colors: {
        ...base.colors,
        background: `#${index.toString(16).padStart(6, "0")}`,
      },
    };
    latestFingerprint = themeFingerprint(theme);
    _cacheChromeThemeCssForTests(theme);
  }

  const stats = _getChromeThemeCssCacheStatsForTests();
  assert.equal(stats.size, CHROME_THEME_CSS_CACHE_MAX_ENTRIES);
  assert.equal(stats.keys.at(-1), latestFingerprint);
});
