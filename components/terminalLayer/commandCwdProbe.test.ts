import test from "node:test";
import assert from "node:assert/strict";

import { shouldProbeCommandCwd } from "./commandCwdProbe";

test("probes command cwd for session restore even when the SFTP panel is not visible", () => {
  assert.equal(
    shouldProbeCommandCwd({
      restoreTerminalCwd: true,
      visibleSftpHost: null,
      sessionHost: { sftpFollowTerminalCwd: false },
      globalSftpFollowTerminalCwd: false,
    }),
    true,
  );
});

test("does not probe command cwd when neither session restore nor SFTP follow cwd needs it", () => {
  assert.equal(
    shouldProbeCommandCwd({
      restoreTerminalCwd: false,
      visibleSftpHost: null,
      sessionHost: { sftpFollowTerminalCwd: true },
      globalSftpFollowTerminalCwd: true,
    }),
    false,
  );
});

test("probes command cwd for visible SFTP follow cwd using host override", () => {
  assert.equal(
    shouldProbeCommandCwd({
      restoreTerminalCwd: false,
      visibleSftpHost: { sftpFollowTerminalCwd: true },
      sessionHost: { sftpFollowTerminalCwd: false },
      globalSftpFollowTerminalCwd: false,
    }),
    true,
  );
});

test("visible SFTP host override can disable command cwd probing", () => {
  assert.equal(
    shouldProbeCommandCwd({
      restoreTerminalCwd: false,
      visibleSftpHost: { sftpFollowTerminalCwd: false },
      sessionHost: { sftpFollowTerminalCwd: true },
      globalSftpFollowTerminalCwd: true,
    }),
    false,
  );
});
