import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { LigaturesAddon } from "@xterm/addon-ligatures";

import {
  DEFAULT_MAX_LIGATURE_CELL_SPAN,
  createBoundedLigaturesAddon,
  createTerminalLigatureController,
  filterLigatureRanges,
  resolveMaxLigatureCellSpan,
  terminalFontLigaturesEnabled,
  type CharacterJoinerHandler,
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
  assert.match(runtimeSource, /createBoundedLigaturesAddon\(\s*new LigaturesAddon\(\)/);
});

test("resolveMaxLigatureCellSpan caps wide ligatures to fit inside a 512px WebGL atlas page", () => {
  assert.equal(resolveMaxLigatureCellSpan(), DEFAULT_MAX_LIGATURE_CELL_SPAN);
  assert.equal(resolveMaxLigatureCellSpan({ deviceCellWidth: 16 }), DEFAULT_MAX_LIGATURE_CELL_SPAN);
  // At 48px device cell width, 10 cells * 48px = 480px <= 512px - 32px margin.
  assert.equal(resolveMaxLigatureCellSpan({ deviceCellWidth: 48 }), 10);
  // At 80px device cell width, 6 cells * 80px = 480px.
  assert.equal(resolveMaxLigatureCellSpan({ deviceCellWidth: 80 }), 6);
  // Extreme zoom where even 2 cells cannot fit in a normal 512px atlas page.
  assert.equal(resolveMaxLigatureCellSpan({ deviceCellWidth: 300 }), 1);
  // Non-finite or non-positive widths fall back cleanly to the configured cap.
  assert.equal(resolveMaxLigatureCellSpan({ deviceCellWidth: 0 }), DEFAULT_MAX_LIGATURE_CELL_SPAN);
  assert.equal(resolveMaxLigatureCellSpan({ deviceCellWidth: Number.NaN }), DEFAULT_MAX_LIGATURE_CELL_SPAN);
});

test("filterLigatureRanges keeps programming ligatures and drops long ASCII rule runs", () => {
  const shortRanges: [number, number][] = [
    [0, 3], // ===
    [5, 8], // !==
    [10, 16], // <---->
  ];
  assert.equal(filterLigatureRanges(shortRanges, DEFAULT_MAX_LIGATURE_CELL_SPAN), shortRanges);

  // Typical nvidia-smi table border (+---...---+, 89 dashes) and === divider (31 equals)
  const mixedRanges: [number, number][] = [
    [1, 90],
    [92, 95],
    [100, 131],
    [135, 136], // single cell: not a ligature
  ];
  assert.deepEqual(
    filterLigatureRanges(mixedRanges, DEFAULT_MAX_LIGATURE_CELL_SPAN),
    [[92, 95]],
  );

  // When zoomed so far that even 2 cells overflow the atlas, drop all ranges.
  assert.deepEqual(filterLigatureRanges(shortRanges, 1), []);
});

test("createBoundedLigaturesAddon filters oversized joiner ranges and tracks dynamic cell width", () => {
  let registeredHandler: CharacterJoinerHandler | undefined;
  let deregisteredId: number | undefined;
  let cellWidth = 17; // 14px @ 2x DPR
  const element = { style: { fontFeatureSettings: "" } };

  const fakeTerminal = {
    element,
    options: { fontFamily: "JetBrains Mono", logLevel: "info" },
    rows: 24,
    refresh() {},
    registerCharacterJoiner(handler: CharacterJoinerHandler) {
      registeredHandler = handler;
      return 42;
    },
    deregisterCharacterJoiner(id: number) {
      deregisteredId = id;
    },
  };

  let innerJoinerId: number | undefined;
  const innerAddon = {
    activate(term: typeof fakeTerminal) {
      innerJoinerId = term.registerCharacterJoiner((text: string) => {
        const ranges: [number, number][] = [];
        const dashMatch = /-{2,}/g;
        let match: RegExpExecArray | null;
        while ((match = dashMatch.exec(text)) !== null) {
          ranges.push([match.index, match.index + match[0].length]);
        }
        return ranges;
      });
      term.element.style.fontFeatureSettings = '"calt" on';
    },
    dispose() {
      if (innerJoinerId !== undefined) {
        fakeTerminal.deregisterCharacterJoiner(innerJoinerId);
      }
      fakeTerminal.element.style.fontFeatureSettings = "";
    },
  };

  const bounded = createBoundedLigaturesAddon(innerAddon, {
    getDeviceCellWidth: () => cellWidth,
  });
  bounded.activate(fakeTerminal);

  assert.equal(innerJoinerId, 42);
  assert.equal(element.style.fontFeatureSettings, '"calt" on');
  assert.ok(registeredHandler, "expected registerCharacterJoiner to be called");

  const nvidiaBorder = `+${"-".repeat(89)}+`;
  assert.deepEqual(registeredHandler(nvidiaBorder), []);

  const lineWithShortAndLong = `a ---> b ${"-".repeat(40)} c <----> d`;
  assert.deepEqual(registeredHandler(lineWithShortAndLong), [
    [2, 5], // --- inside --->
    [53, 57], // ---- inside <---->
  ]);

  // Simulate user zooming in heavily (160px cell width -> max 3 cells)
  cellWidth = 160;
  assert.deepEqual(registeredHandler(lineWithShortAndLong), [
    [2, 5], // 3 cells still fits
  ]);

  bounded.dispose();
  assert.equal(deregisteredId, 42);
  assert.equal(element.style.fontFeatureSettings, "");
});

test("createBoundedLigaturesAddon works with real LigaturesAddon activate and dispose", () => {
  let registeredHandler: CharacterJoinerHandler | undefined;
  let deregisteredId: number | undefined;
  const element = { style: { fontFeatureSettings: "" } };

  const fakeTerminal = {
    element,
    options: { fontFamily: "JetBrains Mono", logLevel: "info" },
    rows: 24,
    refresh() {},
    registerCharacterJoiner(handler: CharacterJoinerHandler) {
      registeredHandler = handler;
      return 7;
    },
    deregisterCharacterJoiner(id: number) {
      deregisteredId = id;
    },
  };

  const bounded = createBoundedLigaturesAddon(new LigaturesAddon(), {
    getDeviceCellWidth: () => 18,
  });
  bounded.activate(fakeTerminal as unknown as Parameters<LigaturesAddon["activate"]>[0]);

  assert.equal(element.style.fontFeatureSettings, '"calt" on');
  assert.ok(registeredHandler);
  assert.deepEqual(registeredHandler("a === b !== c"), [
    [2, 5],
    [8, 11],
  ]);

  bounded.dispose();
  assert.equal(deregisteredId, 7);
  assert.equal(element.style.fontFeatureSettings, "");
});
