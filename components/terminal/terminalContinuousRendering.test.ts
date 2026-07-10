import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
const supportSource = readFileSync(new URL("../terminalLayer/TerminalLayerSupport.tsx", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../terminalLayer/TerminalLayerView.tsx", import.meta.url), "utf8");
const tabBridgeSource = readFileSync(new URL("../terminalLayer/TerminalLayerTabBridge.tsx", import.meta.url), "utf8");
const workspaceLayoutSource = readFileSync(new URL("../terminalLayer/useTerminalWorkspaceLayout.ts", import.meta.url), "utf8");
const layerEffectsSource = readFileSync(new URL("../terminalLayer/useTerminalLayerEffects.ts", import.meta.url), "utf8");

test("renderer activity follows the hibernate setting instead of active-tab visibility", () => {
  assert.match(
    terminalSource,
    /const isRendererActive = isVisible \|\| !resolveTerminalHibernateEnabled\(terminalSettings\)/,
  );
  assert.match(terminalSource, /isVisibleRef: isRendererActiveRef/);
  assert.match(terminalSource, /if \(!isRendererActiveRef\.current && !options\?\.allowHidden\)/);
  assert.match(
    effectsSource,
    /const isRendererActive = isVisible \|\| !hibernateHiddenTabs;[\s\S]*const isRendererActiveRef = useRef\(isRendererActive\)/,
  );
});

test("inactive terminal surfaces remain painted and non-interactive without hibernate", () => {
  assert.match(supportSource, /resolveTerminalHibernateEnabled\(terminalSettings\)/);
  assert.match(supportSource, /inert=\{isVisible \? undefined : true\}/);
  assert.match(viewSource, /resolveTerminalHibernateEnabled\(ctx\.terminalSettings\)/);
  assert.match(viewSource, /inert=\{ctx\.isTerminalLayerVisible \? undefined : true\}/);
});

test("background split workspaces keep their live geometry without hibernate", () => {
  assert.match(
    tabBridgeSource,
    /keepHiddenWorkspacesLaidOut: !hibernateHiddenTabs/,
  );
  assert.match(
    workspaceLayoutSource,
    /if \(keepHiddenWorkspacesLaidOut\) \{[\s\S]*cachedSizeIsUsable[\s\S]*computeWorkspaceRects\(layoutWorkspace, layoutSize\)/,
  );
  assert.match(
    supportSource,
    /const layoutWorkspaceId = activeWorkspaceId \?\? \(!hibernateHiddenTabs \? session\.workspaceId : undefined\)/,
  );
  assert.match(supportSource, /inWorkspace=\{keepsWorkspacePresentation\}/);
  assert.match(
    supportSource,
    /isWorkspaceComposeBarOpen=\{inActiveWorkspace \? isComposeBarOpen : undefined\}/,
  );
  assert.match(
    supportSource,
    /shouldUseTerminalPaneSplitLayout\(\{[\s\S]*workspace: layoutWorkspace,[\s\S]*sessionId: session\.id,[\s\S]*isVisible,[\s\S]*hibernateHiddenTabs/,
  );
  assert.match(
    supportSource,
    /const initializeHiddenFullSize = !hibernateHiddenTabs[\s\S]*&& !rect[\s\S]*&& !lastVisiblePaneSizeRef\.current;[\s\S]*bumpHiddenPaneSizeVersion/,
  );
  assert.match(
    supportSource,
    /if \(isVisible\) \{[\s\S]*const observer = new ResizeObserver\(\(\) => \{[\s\S]*capturePaneSize\(\)/,
  );
  assert.match(
    layerEffectsSource,
    /if \(!shouldMeasureTerminalLayerLayout\) return;[\s\S]*?remeasureWorkspaceArea\(\)/,
  );
  assert.match(
    tabBridgeSource,
    /shouldMeasureTerminalLayerLayout: shouldMeasureTerminalLayerLayout\(\{[\s\S]*hibernateHiddenTabs,[\s\S]*workspaceArea/,
  );
  assert.doesNotMatch(tabBridgeSource, /isTerminalLayerRendererActive/);
});
