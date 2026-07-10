import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
const supportSource = readFileSync(new URL("../terminalLayer/TerminalLayerSupport.tsx", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../terminalLayer/TerminalLayerView.tsx", import.meta.url), "utf8");

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
