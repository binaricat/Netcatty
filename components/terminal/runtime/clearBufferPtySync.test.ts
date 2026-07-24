import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("clearBuffer uses the guarded viewport and ConPTY sync helper", () => {
  const runtimeSource = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  const clearCaseIndex = runtimeSource.indexOf('case "clearBuffer"');
  assert.notEqual(clearCaseIndex, -1);

  const clearCase = runtimeSource.slice(clearCaseIndex, clearCaseIndex + 500);
  assert.match(clearCase, /clearTerminalViewportAndSyncPty\(term,/);
  assert.match(clearCase, /clearSessionPtyBuffer\?\.\(clearId\)/);
});

test("context-menu clear also uses the guarded viewport and ConPTY sync helper", () => {
  const actionsSource = readFileSync(
    new URL("../hooks/useTerminalContextActions.ts", import.meta.url),
    "utf8",
  );
  const onClearIndex = actionsSource.indexOf("const onClear = useCallback");
  assert.notEqual(onClearIndex, -1);
  const onClear = actionsSource.slice(onClearIndex, onClearIndex + 650);
  assert.match(onClear, /clearTerminalViewportAndSyncPty\(term,/);
  assert.match(onClear, /clearSessionPtyBuffer\?\.\(id\)/);
});
