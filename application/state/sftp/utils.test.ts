import test from "node:test";
import assert from "node:assert/strict";

import {
  getParentPath,
  getSftpFilterAfterPathChange,
  getSftpFilterAfterPathChangeError,
  isConcreteTransferTargetPath,
  shouldClearSftpFilterForPathChange,
} from "./utils";

test("concrete transfer target paths exclude temporary placeholders", () => {
  assert.equal(isConcreteTransferTargetPath({ targetPath: "/Users/alice/Downloads/report.pdf" }), true);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "C:\\Users\\alice\\Downloads\\report.pdf" }), true);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "(temp)" }), false);
  assert.equal(isConcreteTransferTargetPath({ targetPath: "   " }), false);
});

test("SFTP filter clears when entering a different directory", () => {
  assert.equal(shouldClearSftpFilterForPathChange("/srv", "/srv/app"), true);
  assert.equal(getSftpFilterAfterPathChange("/srv", "/srv/app", "log"), "");
});

test("SFTP filter clears when navigating to the parent directory", () => {
  assert.equal(shouldClearSftpFilterForPathChange("/srv/app", getParentPath("/srv/app")), true);
  assert.equal(getSftpFilterAfterPathChange("/srv/app", getParentPath("/srv/app"), "dist"), "");
});

test("SFTP filter stays when refreshing the same directory", () => {
  assert.equal(shouldClearSftpFilterForPathChange("/srv/app", "/srv/app"), false);
  assert.equal(shouldClearSftpFilterForPathChange("/srv/app", "/srv/app/"), false);
  assert.equal(shouldClearSftpFilterForPathChange("C:\\Users\\alice", "c:/Users/alice"), false);
  assert.equal(getSftpFilterAfterPathChange("/srv/app", "/srv/app", "log"), "log");
  assert.equal(getSftpFilterAfterPathChange("/srv/app", "/srv/app/", "log"), "log");
  assert.equal(getSftpFilterAfterPathChange("C:\\Users\\alice", "c:/Users/alice", "docs"), "docs");
});

test("SFTP filter restores when changed-directory navigation fails", () => {
  assert.equal(getSftpFilterAfterPathChangeError(true, "log", "typed-while-loading"), "log");
});

test("SFTP filter preserves in-flight edits when same-directory refresh fails", () => {
  assert.equal(getSftpFilterAfterPathChangeError(false, "log", "typed-while-loading"), "typed-while-loading");
});
