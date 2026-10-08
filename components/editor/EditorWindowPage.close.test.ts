import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the custom window close button delegates before touching any renderer-owned tabs", async () => {
  const source = readFileSync(new URL("./EditorWindowPage.tsx", import.meta.url), "utf8");
  const body = source.match(/const handleWindowClose = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[/)?.[1];
  assert.ok(body);
  let closes = 0;
  const fail = () => { throw new Error("Native close must own tab confirmation and the incoming-transfer gate"); };
  const close = new Function("closeWindow", "editorTabStore", "promptUnsavedChanges", "saveTab", "reportDetachedEditorTabsClosed", `return async () => {${body}}`)(
    async () => { closes++; }, { getTabs: fail, close: fail }, fail, fail, fail,
  );
  await close();
  assert.equal(closes, 1);
  assert.match(source, /<EditorWindowControls onClose=\{\(\) => \{ void handleWindowClose\(\); \}\}/);
});
