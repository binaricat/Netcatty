import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

// Regression test for issue #3476: window control buttons must fill the full
// h-9 title bar so the hover highlight and hit area are vertically centered
// around the icon, instead of the buttons sitting in a bottom-anchored h-7 row.
test("window control buttons fill the h-9 title bar with centered hover highlight", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const buttonBlock = css.match(
    /\[data-section="top-tabs"\] \.window-control-btn \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.notEqual(buttonBlock, "", "window-control-btn rule must exist in index.css");
  assert.match(buttonBlock, /height: 2\.25rem/, "buttons must span the full 2.25rem title bar height");

  const beforeBlock = css.match(
    /\[data-section="top-tabs"\] \.window-control-btn::before \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.notEqual(beforeBlock, "");
  assert.match(beforeBlock, /inset: 0/, "hover highlight must cover the whole button box");
  assert.doesNotMatch(beforeBlock, /calc\(/, "no offset hack may remain on the highlight");

  const tsx = readFileSync(new URL("./top-tabs/TopTabItems.tsx", import.meta.url), "utf8");
  const containerMatch = tsx.match(/<div className="[^"]*app-no-drag">\s*\n\s*<button type="button" className=\{controlClassName\}/);
  assert.notEqual(containerMatch, null, "WindowControls container must wrap the control buttons");
  assert.match(containerMatch?.[0] ?? "", /h-9/, "WindowControls container must be h-9 to match the title bar");

  const toolbar = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");
  assert.match(
    toolbar,
    /showWindowControls \? "relative z-20 h-9" : "h-7"/,
    "the containing toolbar must fill the title bar and sit above its drag stripe",
  );
});
