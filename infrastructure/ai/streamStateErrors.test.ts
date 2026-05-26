import assert from "node:assert/strict";
import test from "node:test";

import { isSdkStreamStateError } from "./shared/streamStateErrors";

test("isSdkStreamStateError matches the reasoning-part orphan-delta error", () => {
  assert.equal(isSdkStreamStateError("reasoning part 0 not found"), true);
  assert.equal(isSdkStreamStateError("reasoning part abc-123 not found"), true);
  assert.equal(isSdkStreamStateError("Reasoning Part 0 Not Found"), true);
  assert.equal(isSdkStreamStateError("  reasoning part 7 not found  "), true);
});

test("isSdkStreamStateError matches the text-part orphan-delta error", () => {
  assert.equal(isSdkStreamStateError("text part 0 not found"), true);
  assert.equal(isSdkStreamStateError("text part X not found"), true);
});

test("isSdkStreamStateError accepts the error wrapped in an Error or `{ message }`", () => {
  assert.equal(isSdkStreamStateError(new Error("reasoning part 0 not found")), true);
  assert.equal(isSdkStreamStateError({ message: "reasoning part 0 not found" }), true);
});

test("isSdkStreamStateError ignores unrelated error strings", () => {
  assert.equal(isSdkStreamStateError("Network error"), false);
  assert.equal(
    isSdkStreamStateError("400 messages.13: tool_use ids were found without tool_result blocks"),
    false,
  );
  assert.equal(isSdkStreamStateError("reasoning part not found"), false, "missing the id segment shouldn't match");
  assert.equal(isSdkStreamStateError("a reasoning part 0 not found"), false, "leading text shouldn't match");
});

test("isSdkStreamStateError handles non-error inputs without throwing", () => {
  assert.equal(isSdkStreamStateError(undefined), false);
  assert.equal(isSdkStreamStateError(null), false);
  assert.equal(isSdkStreamStateError(42), false);
  assert.equal(isSdkStreamStateError({}), false);
  assert.equal(isSdkStreamStateError([]), false);
});
