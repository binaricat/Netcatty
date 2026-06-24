import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useTerminalLayerEffects.ts", import.meta.url), "utf8");

test("follow-app terminal theme preview cleanup does not cancel theme clicks", () => {
  assert.doesNotMatch(source, /\[followAppTerminalTheme, themePreview\.targetSessionId, themePreview\.themeId\]/);
});

test("theme preview cleanup also clears the host tree sidebar preview", () => {
  assert.match(source, /clearHostTreePreviewVars\(\)/);
});

test("follow-app mode changes clear previews in either direction", () => {
  assert.match(source, /const didChangeFollowTheme = followAppTerminalTheme !== previousFollowAppTerminalThemeRef\.current/);
  assert.match(source, /if \(!didChangeFollowTheme\) return/);
});

test("terminal activity filter consumes chunks before activity guards", () => {
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
