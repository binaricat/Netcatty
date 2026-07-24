import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("lazy load failures use a real page reload recovery", () => {
  const source = readFileSync(new URL("./ui/lazy-load-boundary.tsx", import.meta.url), "utf8");

  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, />\s*Reload\s*</);
});

test("SFTP text editor keeps a closable dialog while its chunk loads", () => {
  const source = readFileSync(new URL("./sftp/SftpOverlays.tsx", import.meta.url), "utf8");
  const loadingIndex = source.indexOf("const TextEditorModalLoading");
  const suspenseFallbackIndex = source.indexOf("<TextEditorModalLoading", loadingIndex);
  const unavailableIndex = source.indexOf("const TextEditorModalUnavailable");
  const errorFallbackIndex = source.indexOf("<TextEditorModalUnavailable", unavailableIndex);

  assert.notEqual(loadingIndex, -1);
  assert.notEqual(suspenseFallbackIndex, -1);
  assert.notEqual(unavailableIndex, -1);
  assert.notEqual(errorFallbackIndex, -1);
});

test("settings lazy-load errors stay inside the active settings tab", () => {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const errorFallbackIndex = source.indexOf("const SettingsTabLoadError");
  const tabContentIndex = source.indexOf("<SettingsTabContent value={value}>", errorFallbackIndex);
  const boundaryFallbackIndex = source.indexOf("fallback={(error) => <SettingsTabLoadError value={value} error={error} />}");

  assert.notEqual(errorFallbackIndex, -1);
  assert.notEqual(tabContentIndex, -1);
  assert.notEqual(boundaryFallbackIndex, -1);
});

test("Windows settings close uses a plain button without a primary tooltip", () => {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const closeIndex = source.indexOf('aria-label={t("common.close")}');
  assert.notEqual(closeIndex, -1);
  // The old Tooltip + TooltipContent("Close") rendered as a stuck blue chip over the chrome.
  assert.doesNotMatch(
    source.slice(Math.max(0, closeIndex - 200), closeIndex + 400),
    /TooltipContent|TooltipTrigger/,
  );
});
