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
  const scrollIndex = handlerSource.indexOf("flushPendingOutputScroll()");
  const recoveryIndex = handlerSource.indexOf("recoverWebglRendererOnAppResume()");
  const refitIndex = handlerSource.indexOf("scheduleLayoutRecoveryRefit([0, 100, 300])");

  assert.notEqual(flushIndex, -1, "recoverTerminalOnAppResume must flush pending writes");
  assert.notEqual(scrollIndex, -1, "recoverTerminalOnAppResume must flush pending scroll");
  assert.notEqual(recoveryIndex, -1, "recoverTerminalOnAppResume must recover WebGL");
  assert.notEqual(refitIndex, -1, "recoverTerminalOnAppResume must schedule layout recovery");
  assert.ok(flushIndex < scrollIndex, "flush pending writes before pending scroll");
  assert.ok(scrollIndex < recoveryIndex, "flush pending scroll before WebGL recovery");
  assert.ok(recoveryIndex < refitIndex, "recover WebGL before layout recovery");
};

test("app resume handlers flush backlog and recover the terminal renderer before refit", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  const resumeEffectIndex = source.indexOf("const recoverWebglRendererOnAppResume = () => {");
  const resumeEffectEnd = source.indexOf("// Only register the snippet executor", resumeEffectIndex);
  const resumeEffectSource = source.slice(resumeEffectIndex, resumeEffectEnd);

  assert.ok(resumeEffectIndex >= 0);
  assert.ok(resumeEffectEnd > resumeEffectIndex);
  assertRecoverTerminalOnAppResumeOrder(source);
  assert.match(
    resumeEffectSource,
    /const handleVisibilityChange = \(\) => \{\s*if \(document\.visibilityState !== 'visible'\) return;\s*recoverTerminalOnAppResume\(\);\s*\};/,
  );
  assert.match(
    resumeEffectSource,
    /const handleWindowFocus = \(\) => \{\s*recoverTerminalOnAppResume\(\);\s*\};/,
  );
  assert.match(
    resumeEffectSource,
    /const unsubscribeWindowShown = terminalBackend\.onWindowShown\?\.\(\(\) => \{\s*recoverTerminalOnAppResume\(\);\s*\}\);/,
  );
  assert.doesNotMatch(resumeEffectSource, /\binWorkspace\b/);
  assert.doesNotMatch(resumeEffectSource, /\bisFocusMode\b/);
  assert.doesNotMatch(resumeEffectSource, /\bisFocused\b/);
  assert.doesNotMatch(source, /shouldRecoverOnAppResume/);
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
