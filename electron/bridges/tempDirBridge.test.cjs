const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const tempDirBridge = require("./tempDirBridge.cjs");

test("getTempFilePath is unique for duplicate names in the same millisecond", () => {
  const originalNow = Date.now;
  Date.now = () => 1234567890;
  try {
    const first = tempDirBridge.getTempFilePath("upload.txt");
    const second = tempDirBridge.getTempFilePath("upload.txt");

    assert.notEqual(first, second);
    assert.equal(path.basename(first).endsWith("_upload.txt"), true);
    assert.equal(path.basename(second).endsWith("_upload.txt"), true);
  } finally {
    Date.now = originalNow;
  }
});
