import test from "node:test";
import assert from "node:assert/strict";

import { canReplaceConflict } from "./SftpConflictDialog.tsx";

test("does not offer replace when a file upload conflicts with an existing directory", () => {
  assert.equal(canReplaceConflict({
    isDirectory: false,
    existingType: "directory",
  }), false);
});

test("does not offer replace when a directory upload conflicts with an existing file", () => {
  assert.equal(canReplaceConflict({
    isDirectory: true,
    existingType: "file",
  }), false);
});

test("offers replace when a file upload conflicts with an existing file", () => {
  assert.equal(canReplaceConflict({
    isDirectory: false,
    existingType: "file",
  }), true);
});
