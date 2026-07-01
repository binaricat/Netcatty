"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateSessionInList, intersectSessionIds } = require("./scope.cjs");

test("validateSessionInList rejects unknown sessions", () => {
  const result = validateSessionInList("sess-2", ["sess-1"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "SESSION_NOT_IN_SCOPE");
});

test("intersectSessionIds narrows explicit scope", () => {
  assert.deepEqual(
    intersectSessionIds(["a", "b", "c"], ["b", "c", "d"]),
    ["b", "c"],
  );
});
