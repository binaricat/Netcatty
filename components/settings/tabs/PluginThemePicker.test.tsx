import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type {
  ThemePackCatalog,
  ThemePackEntry,
} from "@netcatty/plugin-contract";

test("host theme picker previews without persistence, applies, restores, and cancels stale owners safely", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost", pretendToBeVisual: true },
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : key === "window"
            ? dom.window
            : dom.window[key as keyof typeof dom.window],
    });
  }
  const { default: React, act, useLayoutEffect } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import(
    "../../../application/i18n/I18nProvider"
  );
  const { PluginThemePicker } = await import("./PluginThemePicker");
  const { pluginThemeRegistry: registry } = await import(
    "../../../infrastructure/config/pluginThemeRegistry"
  );
  const { usePluginThemeRevision } = await import(
    "../../../application/state/usePluginThemeRuntime"
  );
  const { getUiThemeById } = await import(
    "../../../infrastructure/config/uiThemes"
  );
  const { applyThemeTokens } = await import(
    "../../../application/state/settingsStateDefaults"
  );
  const entry: ThemePackEntry = {
    ref: {
      pluginId: "com.example.theme",
      themeId: "com.example.theme.forest",
      version: "1.0.0",
      digest: "a".repeat(64),
      variant: "light",
    },
    label: "Forest",
    pluginName: "Synthetic Theme",
    dataOnly: true,
    palette: { formatVersion: 1, base: "light", colors: { accent: "#166534" } },
  };
  let writes = 0,
    restores = 0;
  let catalog: ThemePackCatalog = {
    selection: {
      formatVersion: 1,
      revision: registry.getCatalog().selection.revision + 1,
      light: null,
      dark: null,
    },
    entries: [entry],
    diagnostics: [],
  };
  registry.setCatalog(catalog);
  Object.assign(dom.window, {
    netcatty: {
      async applyPluginTheme(request: {
        expectedRevision: number;
        choice: ThemePackCatalog["selection"]["light"];
      }) {
        assert.equal(request.expectedRevision, catalog.selection.revision);
        writes++;
        catalog = {
          ...catalog,
          selection: {
            ...catalog.selection,
            revision: catalog.selection.revision + 1,
            light: request.choice,
          },
        };
        registry.setCatalog(catalog);
        return catalog;
      },
    },
  });
  function Fixture() {
    const revision = usePluginThemeRevision();
    useLayoutEffect(
      () =>
        applyThemeTokens(
          "light",
          "light",
          getUiThemeById("light", "snow").tokens,
          "theme",
          "",
        ),
      [revision],
    );
    return (
      <I18nProvider locale="en">
        <PluginThemePicker mode="light" onRestore={() => restores++} />
      </I18nProvider>
    );
  }
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === label,
    )!;
  try {
    await act(async () => root.render(<Fixture />));
    const original =
      document.documentElement.style.getPropertyValue("--primary");
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = `${entry.ref.pluginId}/${entry.ref.themeId}`;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Preview").click());
    assert.equal(writes, 0);
    assert.equal(
      getUiThemeById("light", "snow", false).tokens.primary,
      original,
      "local preview does not enter the global plugin view environment",
    );
    assert.notEqual(
      document.documentElement.style.getPropertyValue("--primary"),
      original,
    );
    assert.ok(
      document.documentElement.hasAttribute("data-plugin-theme-active"),
    );
    assert.ok(
      document.documentElement.style.getPropertyValue(
        "--host-security-primary",
      ),
    );
    await act(async () => button("Cancel preview").click());
    assert.equal(
      document.documentElement.style.getPropertyValue("--primary"),
      original,
    );
    assert.equal(writes, 0);
    await act(async () => {
      button("Preview").click();
      button("Apply").click();
    });
    assert.equal(writes, 1);
    assert.equal(catalog.selection.light?.ref.themeId, entry.ref.themeId);
    await act(async () => button("Restore default").click());
    assert.equal(writes, 2);
    assert.equal(restores, 1);
    assert.equal(catalog.selection.light, null);
    await act(async () => {
      registry.startPreview("old-owner", entry);
      registry.startPreview("new-owner", entry);
      registry.cancelPreview("old-owner");
    });
    assert.notEqual(
      document.documentElement.style.getPropertyValue("--primary"),
      original,
    );
    await act(async () =>
      registry.setCatalog({
        ...catalog,
        selection: {
          ...catalog.selection,
          revision: catalog.selection.revision + 1,
        },
        entries: [],
      }),
    );
    assert.equal(
      document.documentElement.style.getPropertyValue("--primary"),
      original,
      "package withdrawal cancels previews",
    );
    await act(async () =>
      registry.setCatalog({
        ...catalog,
        selection: {
          ...catalog.selection,
          revision: catalog.selection.revision + 2,
          light: { ref: entry.ref },
        },
        entries: [],
      }),
    );
    assert.equal(getUiThemeById("light", "snow").id, "host-plugin-fallback");
    await act(async () => registry.setHighContrast(true));
    assert.equal(getUiThemeById("light", "snow").id, "host-high-contrast");
  } finally {
    await act(async () => {
      root.unmount();
      registry.setHighContrast(false);
      registry.setCatalog({
        ...catalog,
        selection: {
          formatVersion: 1,
          revision: registry.getCatalog().selection.revision + 1,
          light: null,
          dark: null,
        },
        entries: [],
      });
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
