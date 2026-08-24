import assert from "node:assert/strict";
import test from "node:test";
import { isMissingStatError } from "./sftpStatError";

test("isMissingStatError recognizes ssh2 and Electron-wrapped absence", () => {
  assert.equal(isMissingStatError(new Error("No such file")), true);
  assert.equal(
    isMissingStatError(
      new Error("Error invoking remote method 'netcatty:sftp:lstat': Error: No such file"),
    ),
    true,
  );
});

test("isMissingStatError does not treat path substrings as absence", () => {
  assert.equal(
    isMissingStatError(
      new Error("EACCES: permission denied, lstat '/private/enoent/report.txt'"),
    ),
    false,
  );
});
