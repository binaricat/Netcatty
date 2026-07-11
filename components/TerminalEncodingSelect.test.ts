import test from "node:test";
import assert from "node:assert/strict";

import {
  getTerminalEncodingOptions,
  resolveTerminalEncodingSelectValue,
} from "./TerminalEncodingSelect.tsx";

test("terminal encoding selector advertises the supported encodings", () => {
  assert.deepEqual(getTerminalEncodingOptions(), ["UTF-8", "GB18030"]);
});

test("terminal encoding selector preserves an existing custom encoding", () => {
  assert.deepEqual(getTerminalEncodingOptions("Shift_JIS"), ["Shift_JIS", "UTF-8", "GB18030"]);
});

test("terminal encoding selector normalizes supported values to their displayed option", () => {
  assert.equal(resolveTerminalEncodingSelectValue("utf-8"), "UTF-8");
  assert.equal(resolveTerminalEncodingSelectValue("gb18030"), "GB18030");
  assert.equal(resolveTerminalEncodingSelectValue("Shift_JIS"), "Shift_JIS");
});
