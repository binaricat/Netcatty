import assert from "node:assert/strict";
import test from "node:test";
import { isMissingStatError } from "./errors";

test("isMissingStatError accepts only true path absence codes", () => {
  for (const code of [2, "ENOENT", "NO_SUCH_FILE", "SSH_FX_NO_SUCH_FILE"] as const) {
    const error = new Error("missing") as Error & { code: string | number };
    error.code = code;
    assert.equal(isMissingStatError(error), true, String(code));
  }
  assert.equal(isMissingStatError(new Error("ENOENT")), true);
});

test("isMissingStatError treats Electron-wrapped SFTP absence as missing", () => {
  // ipcRenderer.invoke strips custom `code` and wraps the ssh2 message.
  // New-file uploads lstat the destination first; this is the toast users see.
  assert.equal(
    isMissingStatError(
      new Error("Error invoking remote method 'netcatty:sftp:lstat': Error: No such file"),
    ),
    true,
  );
  assert.equal(isMissingStatError(new Error("No such file")), true);
  assert.equal(isMissingStatError(new Error("No such file or directory")), true);
  assert.equal(isMissingStatError(new Error("No such file: /tmp/tool.sh")), true);
  assert.equal(
    isMissingStatError(new Error("ENOENT: no such file or directory, lstat '/tmp/tool.sh'")),
    true,
  );
});

test("isMissingStatError rejects unsupported LSTAT and other failures", () => {
  const enotsup = new Error("Remote server does not support LSTAT") as Error & {
    code: string;
    lstatUnavailable: boolean;
  };
  enotsup.code = "ENOTSUP";
  enotsup.lstatUnavailable = true;
  assert.equal(isMissingStatError(enotsup), false);

  const eperm = new Error("denied") as Error & { code: string };
  eperm.code = "EPERM";
  assert.equal(isMissingStatError(eperm), false);
  assert.equal(isMissingStatError(new Error("channel closed")), false);
  assert.equal(
    isMissingStatError(
      new Error("Error invoking remote method 'netcatty:sftp:lstat': Error: Permission denied"),
    ),
    false,
  );
  // Path names are user-controlled; do not treat a substring hit as absence.
  assert.equal(
    isMissingStatError(
      new Error("EACCES: permission denied, lstat '/private/enoent/report.txt'"),
    ),
    false,
  );
  assert.equal(
    isMissingStatError(
      new Error(
        "Error invoking remote method 'netcatty:sftp:lstat': Error: EACCES: permission denied, lstat '/private/enoent/report.txt'",
      ),
    ),
    false,
  );
});
