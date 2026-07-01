import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useTerminalLayerEffects.ts", import.meta.url), "utf8");

test("theme preview DOM effects were removed in favor of ThemeRuntime injection", () => {
  assert.doesNotMatch(source, /themePreview/);
  assert.doesNotMatch(source, /applyTerminalPreviewVars/);
  assert.doesNotMatch(source, /clearHostTreePreviewVars/);
  assert.doesNotMatch(source, /applyTopTabsPreviewVars/);
  assert.doesNotMatch(source, /themeCommitTimerRef/);
});

test("terminal activity filter stays in sync before notification guards", () => {
  const subscriptionIndex = source.indexOf("return onSessionData(session.id, (chunk) => {");
  const filterIndex = source.indexOf("const hasNotifiableOutput = hasNotifiableTerminalOutput(filter, chunk);", subscriptionIndex);
  const visibleGuardIndex = source.indexOf("if (!shouldMarkSessionActivity(activeTabIdRef.current, session))", subscriptionIndex);
  const alreadyActiveGuardIndex = source.indexOf("if (sessionActivityStore.getSnapshot()[session.id])", subscriptionIndex);

  assert.notEqual(subscriptionIndex, -1);
  assert.notEqual(filterIndex, -1);
  assert.notEqual(visibleGuardIndex, -1);
  assert.notEqual(alreadyActiveGuardIndex, -1);
  assert.ok(filterIndex < visibleGuardIndex);
  assert.ok(filterIndex < alreadyActiveGuardIndex);
});
