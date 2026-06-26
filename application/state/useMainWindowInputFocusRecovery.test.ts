import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("useMainWindowInputFocusRecovery listens for visibility and window focus", () => {
  const source = readProjectFile("application/state/useMainWindowInputFocusRecovery.ts");

  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /scheduleWindowInputFocus\(\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.match(source, /window\.addEventListener\("focus", recoverFocus\)/);
});

test("useMainWindowInputFocusRecovery dismisses transient UI when the page hides", () => {
  const source = readProjectFile("application/state/useMainWindowInputFocusRecovery.ts");

  assert.match(source, /document\.visibilityState === "hidden"/);
  assert.match(source, /onPageHidden\?\.\(\)/);
  assert.match(source, /onWindowShown/);
  assert.match(source, /onWindowWillHide/);
  assert.match(source, /cancelPendingFocusRecovery/);
});

test("scheduleWindowInputFocus skips deferred focus when the page is hidden", () => {
  const source = readProjectFile("application/state/windowInputFocus.ts");

  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /cancelAnimationFrame/);
  assert.match(source, /clearTimeout/);
});

test("AppView mounts main-window input focus recovery with overlay dismiss", () => {
  const source = readProjectFile("application/app/AppView.tsx");

  assert.match(source, /useMainWindowInputFocusRecovery\(\{ onPageHidden: dismissTransientOverlays \}\)/);
  assert.match(source, /setIsQuickSwitcherOpen\(false\)/);
  assert.match(source, /setProtocolSelectHost\(null\)/);
});

test("dropdown closes when the document becomes hidden", () => {
  const source = readProjectFile("components/ui/dropdown.tsx");

  assert.match(source, /document\.visibilityState === "hidden"/);
  assert.match(source, /setOpen\(false\)/);
});
