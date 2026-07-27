import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVaultImportDestination,
  getVaultImportPickerMode,
  selectVaultImportFiles,
} from "./vaultImportSelection.ts";

test("SecureCRT uses a directory picker and keeps every selected session file", () => {
  const files = [
    new File(["one"], "one.ini"),
    new File(["two"], "two.ini"),
  ];

  assert.deepEqual(getVaultImportPickerMode("securecrt"), {
    directory: true,
    multiple: true,
  });
  assert.deepEqual(getVaultImportPickerMode("securecrt", "file"), {
    directory: false,
    multiple: false,
  });
  assert.deepEqual(selectVaultImportFiles("securecrt", files), files);
  assert.deepEqual(selectVaultImportFiles("csv", files), [files[0]]);
});

test("vault import destination supports preserve, existing, and new groups", () => {
  assert.deepEqual(buildVaultImportDestination({ mode: "preserve" }), {
    mode: "preserve",
  });
  assert.deepEqual(buildVaultImportDestination({
    mode: "existing",
    existingGroup: "Production/Linux",
  }), {
    mode: "group",
    group: "Production/Linux",
  });
  assert.deepEqual(buildVaultImportDestination({
    mode: "new",
    newGroup: " Imported / July ",
  }), {
    mode: "group",
    group: "Imported/July",
  });
  assert.equal(buildVaultImportDestination({ mode: "new", newGroup: "  " }), null);
});

test("vault import destination rejects an existing group that was deleted", () => {
  assert.equal(buildVaultImportDestination({
    mode: "existing",
    existingGroup: "Deleted",
    availableGroups: ["Production"],
  }), null);
});
