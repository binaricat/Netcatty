import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("clearBuffer syncs ConPTY after clearing the local xterm viewport", () => {
  const runtimeSource = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  const clearCaseIndex = runtimeSource.indexOf('case "clearBuffer"');
  assert.notEqual(clearCaseIndex, -1);

  const clearCase = runtimeSource.slice(clearCaseIndex, clearCaseIndex + 500);
  assert.match(clearCase, /const didClearViewport = clearTerminalViewport\(term,/);
  assert.match(clearCase, /if \(didClearViewport && clearId\)/);
});

test("context-menu clear also syncs the ConPTY buffer", () => {
  const actionsSource = readFileSync(
    new URL("../hooks/useTerminalContextActions.ts", import.meta.url),
    "utf8",
  );
  const onClearIndex = actionsSource.indexOf("const onClear = useCallback");
  assert.notEqual(onClearIndex, -1);
  const onClear = actionsSource.slice(onClearIndex, onClearIndex + 550);
  assert.match(onClear, /const didClearViewport = clearTerminalViewport\(term,/);
  assert.match(onClear, /if \(didClearViewport && id\)/);
});
