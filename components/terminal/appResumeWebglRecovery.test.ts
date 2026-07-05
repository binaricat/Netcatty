import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const assertRecoverTerminalOnAppResumeOrder = (source: string): void => {
  const handlerIndex = source.indexOf("const recoverTerminalOnAppResume = () => {");
  assert.notEqual(handlerIndex, -1, "recoverTerminalOnAppResume must exist");

  const bodyStart = source.indexOf("{", handlerIndex);
  assert.notEqual(bodyStart, -1, "recoverTerminalOnAppResume must have a body");

  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index + 1;
        break;
      }
    }
  }
  assert.notEqual(bodyEnd, -1, "recoverTerminalOnAppResume body must close");

  const handlerSource = source.slice(handlerIndex, bodyEnd);
  const flushIndex = handlerSource.indexOf("flushPendingTerminalWritesOnResume(term)");
  const recoveryIndex = handlerSource.indexOf("recoverWebglRendererOnAppResume()");
  const refitIndex = handlerSource.indexOf("scheduleLayoutRecoveryRefit()");

  assert.notEqual(flushIndex, -1, "recoverTerminalOnAppResume must flush pending writes");
  assert.notEqual(recoveryIndex, -1, "recoverTerminalOnAppResume must recover WebGL");
  assert.notEqual(refitIndex, -1, "recoverTerminalOnAppResume must schedule layout recovery");
  assert.ok(flushIndex < recoveryIndex, "flush pending writes before WebGL recovery");
  assert.ok(recoveryIndex < refitIndex, "recover WebGL before layout recovery");
};

test("app resume handlers flush backlog and recover the terminal renderer before refit", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");

  assertRecoverTerminalOnAppResumeOrder(source);
  assert.match(source, /handleVisibilityChange[\s\S]*recoverTerminalOnAppResume\(\)/);
  assert.match(source, /handleWindowFocus[\s\S]*recoverTerminalOnAppResume\(\)/);
  assert.match(source, /onWindowShown\?\.\(\(\) => \{[\s\S]*recoverTerminalOnAppResume\(\)/);
});

test("useTerminalBackend exposes onWindowShown so the resume hook actually fires", () => {
  const source = readFileSync(
    new URL("../../application/state/useTerminalBackend.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const onWindowShown = useCallback\(\(cb: \(\) => void\) => \{\s*const bridge = netcattyBridge\.get\(\);\s*return bridge\?\.onWindowShown\?\.\(cb\);/);
  const returnIndex = source.indexOf("useMemo(");
  assert.notEqual(returnIndex, -1);
  assert.match(source.slice(returnIndex), /onWindowShown,/);
});
