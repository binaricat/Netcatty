import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { LigaturesAddon } from "@xterm/addon-ligatures";

import {
  createTerminalLigatureController,
  terminalFontLigaturesEnabled,
  type TerminalLigatureAddon,
} from "./terminalFontLigatures";

class FakeAddon implements TerminalLigatureAddon {
  disposeCalls = 0;

  dispose() {
    this.disposeCalls += 1;
  }
}

function createHarness(webglActive = false) {
  const events: string[] = [];
  const addons: FakeAddon[] = [];
  const warnings: string[] = [];
  let failLoad = false;

  const controller = createTerminalLigatureController({
    createAddon: () => {
      const addon = new FakeAddon();
      addons.push(addon);
      events.push("create");
      return addon;
    },
    loadAddon: () => {
      events.push("load");
      if (failLoad) throw new Error("load failed");
    },
    isWebglActive: () => webglActive,
    recreateWebgl: () => {
      events.push("recreate");
    },
    repaint: () => {
      events.push("repaint");
    },
    warn: (message) => warnings.push(message),
  });

  return {
    controller,
    events,
    addons,
    warnings,
    setWebglActive(active: boolean) {
      webglActive = active;
    },
    failNextLoad() {
      failLoad = true;
    },
  };
}

test("the ligatures addon can be constructed for this xterm version", () => {
  const addon = new LigaturesAddon();
  assert.equal(typeof addon.activate, "function");
  assert.equal(typeof addon.dispose, "function");
  addon.dispose();
});

test("font ligatures follow the terminal setting and default on", () => {
  assert.equal(terminalFontLigaturesEnabled(undefined), true);
  assert.equal(terminalFontLigaturesEnabled({}), true);
  assert.equal(terminalFontLigaturesEnabled({ fontLigatures: true }), true);
  assert.equal(terminalFontLigaturesEnabled({ fontLigatures: false }), false);
});

test("enabling ligatures before WebGL exists does not rebuild the renderer", () => {
  const harness = createHarness(false);

  harness.controller.apply(false);
  assert.deepEqual(harness.events, []);

  harness.controller.apply(true);
  assert.deepEqual(harness.events, ["create", "load", "repaint"]);

  harness.controller.apply(true);
  assert.deepEqual(harness.events, ["create", "load", "repaint"]);
});

test("toggling ligatures rebuilds an active WebGL renderer after the addon updates", () => {
  const harness = createHarness(true);

  harness.controller.apply(true);
  assert.deepEqual(harness.events, ["create", "load", "recreate", "repaint"]);

  harness.controller.apply(false);
  assert.equal(harness.addons[0]?.disposeCalls, 1);
  assert.deepEqual(harness.events, [
    "create",
    "load",
    "recreate",
    "repaint",
    "recreate",
    "repaint",
  ]);
});

test("a failed ligature load leaves WebGL untouched so the terminal can still render", () => {
  const harness = createHarness(true);
  harness.failNextLoad();

  harness.controller.apply(true);

  assert.equal(harness.addons[0]?.disposeCalls, 1);
  assert.deepEqual(harness.events, ["create", "load"]);
  assert.deepEqual(harness.warnings, ["[XTerm] Ligatures addon failed to load"]);
});

test("the terminal runtime activates ligatures before the first WebGL load", () => {
  const runtimeSource = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  const effectsSource = readFileSync(new URL("../useTerminalEffects.ts", import.meta.url), "utf8");
  const settingsSource = readFileSync(
    new URL("../../settings/tabs/SettingsTerminalTab.tsx", import.meta.url),
    "utf8",
  );

  const applyIndex = runtimeSource.indexOf(
    "ligatures.apply(terminalFontLigaturesEnabled(settings))",
  );
  const firstWebglLoad = runtimeSource.indexOf("loadWebglRenderer()", applyIndex);
  assert.notEqual(applyIndex, -1);
  assert.notEqual(firstWebglLoad, -1);
  assert.ok(
    firstWebglLoad > applyIndex,
    "font-feature-settings must be on the terminal element before WebGL creates its glyph atlas",
  );

  const disposeBodyStart = runtimeSource.indexOf("dispose: () => {");
  const disposeBody = runtimeSource.slice(disposeBodyStart);
  const ligatureDispose = disposeBody.indexOf("ligatures.dispose()");
  const termDispose = disposeBody.indexOf("term.dispose()");
  assert.notEqual(ligatureDispose, -1);
  assert.ok(ligatureDispose < termDispose, "release the joiner before xterm tears down the element");

  assert.match(
    effectsSource,
    /syncFontLigatures\(\s*terminalFontLigaturesEnabled\(terminalSettings\),\s*\)/,
  );
  assert.match(settingsSource, /updateTerminalSetting\("fontLigatures", v\)/);
});
