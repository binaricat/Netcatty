import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { STORAGE_KEY_UI_LANGUAGE } from "../../infrastructure/config/storageKeys.ts";
import { useSettingsState } from "./useSettingsState.ts";

const withLanguageDom = async (
  options: {
    storedLanguage?: string;
    languages?: readonly string[];
    language?: string;
  },
  run: (env: {
    dom: JSDOM;
    root: Root;
    setLanguageCalls: string[];
  }) => Promise<void>,
) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const globalAny = globalThis as Record<string, unknown>;
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      languages: options.languages ?? [],
      language: options.language ?? "",
    },
  });
  Object.defineProperty(globalAny, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const setLanguageCalls: string[] = [];
  dom.window.netcatty = {
    setLanguage: async (language: string) => {
      setLanguageCalls.push(language);
      return true;
    },
    notifySettingsChanged: () => {},
  } as unknown as Window["netcatty"];

  if (options.storedLanguage !== undefined) {
    dom.window.localStorage.setItem(STORAGE_KEY_UI_LANGUAGE, options.storedLanguage);
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await run({ dom, root, setLanguageCalls });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    for (const [key, desc] of Object.entries(saved)) {
      const targetKey = key === "actEnv" ? "IS_REACT_ACT_ENVIRONMENT" : key;
      if (desc) {
        Object.defineProperty(globalThis, targetKey, desc);
      } else {
        delete globalAny[targetKey];
      }
    }
  }
};

test("useSettingsState defaults UI language to system locale on first launch", async () => {
  await withLanguageDom(
    { languages: ["zh-CN", "en-US"], language: "zh-CN" },
    async ({ dom, root, setLanguageCalls }) => {
      let observedLanguage = "";
      function Probe() {
        const settings = useSettingsState({ enableSettingsSync: false, enableSystemEffects: false });
        observedLanguage = settings.uiLanguage;
        return null;
      }

      await act(async () => {
        root.render(React.createElement(Probe));
      });

      assert.equal(observedLanguage, "zh-CN");
      assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_UI_LANGUAGE), "zh-CN");
      assert.equal(dom.window.document.documentElement.lang, "zh-CN");
      assert.deepEqual(setLanguageCalls, ["zh-CN"]);
    },
  );
});

test("useSettingsState maps Traditional Chinese priority locale on first launch", async () => {
  await withLanguageDom(
    { languages: ["ja-JP", "zh-HK", "en-US"], language: "ja-JP" },
    async ({ dom, root, setLanguageCalls }) => {
      let observedLanguage = "";
      function Probe() {
        const settings = useSettingsState({ enableSettingsSync: false, enableSystemEffects: false });
        observedLanguage = settings.uiLanguage;
        return null;
      }

      await act(async () => {
        root.render(React.createElement(Probe));
      });

      assert.equal(observedLanguage, "zh-TW");
      assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_UI_LANGUAGE), "zh-TW");
      assert.equal(dom.window.document.documentElement.lang, "zh-TW");
      assert.deepEqual(setLanguageCalls, ["zh-TW"]);
    },
  );
});

test("useSettingsState preserves explicit stored UI language over system locale", async () => {
  await withLanguageDom(
    { storedLanguage: "en", languages: ["zh-CN"], language: "zh-CN" },
    async ({ dom, root, setLanguageCalls }) => {
      let observedLanguage = "";
      function Probe() {
        const settings = useSettingsState({ enableSettingsSync: false, enableSystemEffects: false });
        observedLanguage = settings.uiLanguage;
        return null;
      }

      await act(async () => {
        root.render(React.createElement(Probe));
      });

      assert.equal(observedLanguage, "en");
      assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_UI_LANGUAGE), "en");
      assert.equal(dom.window.document.documentElement.lang, "en");
      assert.deepEqual(setLanguageCalls, ["en"]);
    },
  );
});
