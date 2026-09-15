import test from "node:test";
import assert from "node:assert/strict";

import {
  getPendingMultilinePasteConfirm,
  requestMultilinePasteConfirm,
  respondMultilinePasteConfirm,
  subscribeMultilinePasteConfirm,
} from "./multilinePasteConfirmStore";

test("request stores the pending paste and respond resolves it", async () => {
  const pending = requestMultilinePasteConfirm({
    text: "line1\nline2",
    lineCount: 2,
    charCount: 12,
  });
  assert.equal(getPendingMultilinePasteConfirm()?.lineCount, 2);

  respondMultilinePasteConfirm("line-by-line", "line1\nline2\nline3");
  const response = await pending;
  assert.deepEqual(response, { action: "line-by-line", text: "line1\nline2\nline3" });
  assert.equal(getPendingMultilinePasteConfirm(), null);
});

test("respond without text falls back to the original request text", async () => {
  const pending = requestMultilinePasteConfirm({
    text: "line1\nline2",
    lineCount: 2,
    charCount: 12,
  });
  respondMultilinePasteConfirm("send");
  const response = await pending;
  assert.deepEqual(response, { action: "send", text: "line1\nline2" });
});

test("a newer paste request supersedes the pending one as cancelled", async () => {
  const first = requestMultilinePasteConfirm({ text: "a\nb", lineCount: 2, charCount: 3 });
  const second = requestMultilinePasteConfirm({ text: "c\nd", lineCount: 2, charCount: 3 });
  assert.equal(getPendingMultilinePasteConfirm()?.text, "c\nd");

  respondMultilinePasteConfirm("send", "c\nd");
  assert.deepEqual(await first, { action: "cancel", text: "a\nb" });
  assert.deepEqual(await second, { action: "send", text: "c\nd" });
});

test("respond without a pending request is a no-op and listeners are notified", async () => {
  respondMultilinePasteConfirm("send");
  assert.equal(getPendingMultilinePasteConfirm(), null);

  const events: Array<string | null> = [];
  const unsubscribe = subscribeMultilinePasteConfirm(() => {
    events.push(getPendingMultilinePasteConfirm()?.id ?? "cleared");
  });
  const pending = requestMultilinePasteConfirm({ text: "x", lineCount: 1, charCount: 1 });
  const pendingId = getPendingMultilinePasteConfirm()?.id ?? null;
  respondMultilinePasteConfirm("cancel", "x");
  await pending;
  unsubscribe();

  assert.ok(pendingId);
  assert.deepEqual(events, [pendingId, "cleared"]);
});
