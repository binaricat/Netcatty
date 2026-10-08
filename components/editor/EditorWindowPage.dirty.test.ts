import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a failed detached save re-reports the tab's dirty state after the debounce clear", async () => {
  const source = readFileSync(new URL("./EditorWindowPage.tsx", import.meta.url), "utf8");
  const body = source.match(/const handleSave = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[tabId, t\]\)/)?.[1];
  assert.ok(body, "handleSave body not found");

  const timers = [];
  const globalWindow = {
    clearTimeout: (id) => { timers.splice(timers.indexOf(id), 1); },
    setTimeout: (fn, ms) => { const id = `t${timers.length}`; timers.push(id); return id; },
  };
  const reports = [];
  const tab = { placement: "window", windowDirty: true, content: "edited", baselineContent: "original" };
  const store = { getTab: (tabId) => (tabId === "edt_1" ? tab : null) };
  const savedToasts = [];
  const deps = {
    window: globalWindow,
    saveDetachedEditorTab: async () => ({ ok: false, error: "disk full" }),
    saveDetachedEditorTabOk: async () => ({ ok: true }),
    editorTabStore: store,
    tabIsDirty: () => true,
    reportDetachedEditorDirty: (tabId, dirty) => { reports.push({ tabId, dirty }); },
    toast: { error: () => savedToasts.push("error"), success: () => savedToasts.push("success") },
    t: (key) => key,
  };

  // Cancelled the pending dirty report before the save started, then the
  // failure path must re-report the current dirty state.
  const run = new Function(
    ...Object.keys(deps), "tabId", "dirtyReportTimerRef",
    `return async () => {${body}}`,
  )(...Object.values(deps), "edt_1", { current: timers[0] ?? "t0" });

  timers.push("t0");
  await run();

  assert.equal(savedToasts.at(-1), "error");
  assert.deepEqual(reports, [{ tabId: "edt_1", dirty: true }]);
  assert.deepEqual(timers, [], "pending dirty report must be cancelled before the save");
});
