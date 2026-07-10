import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("app resume does not pause or recover continuously rendered terminals", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /recoverTerminalOnAppResume/);
  assert.doesNotMatch(source, /recoverWebglRendererOnAppResume/);
  assert.doesNotMatch(source, /document\.addEventListener\('visibilitychange'/);
  assert.doesNotMatch(source, /window\.addEventListener\('focus'/);
  assert.doesNotMatch(source, /terminalBackend\.onWindowShown/);
});

test("useTerminalBackend may still expose window shown for non-terminal consumers", () => {
  const source = readFileSync(
    new URL("../../application/state/useTerminalBackend.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const onWindowShown = useCallback\(\(cb: \(\) => void\) => \{\s*const bridge = netcattyBridge\.get\(\);\s*return bridge\?\.onWindowShown\?\.\(cb\);/);
  const returnIndex = source.indexOf("useMemo(");
  assert.notEqual(returnIndex, -1);
  assert.match(source.slice(returnIndex), /onWindowShown,/);
});
