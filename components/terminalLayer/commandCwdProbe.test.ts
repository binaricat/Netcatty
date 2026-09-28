import test from "node:test";
import assert from "node:assert/strict";

import { resolveCommandCwdProbeMode, shouldProbeCommandCwd } from "./commandCwdProbe";

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

test("does not probe command cwd on single-channel SSH hosts", () => {
  assert.equal(
    shouldProbeCommandCwd({
      restoreTerminalCwd: true,
      visibleSftpHost: { sftpFollowTerminalCwd: true },
      sessionHost: { sftpFollowTerminalCwd: true },
      globalSftpFollowTerminalCwd: true,
      restrictExtraSshChannels: true,
    }),
    false,
  );
});

const followVisible = {
  restoreTerminalCwd: false,
  visibleSftpHost: { sftpFollowTerminalCwd: true },
  sessionHost: { sftpFollowTerminalCwd: true },
  globalSftpFollowTerminalCwd: true,
};

test("single-channel cd uses the interactive shell instead of an extra exec", () => {
  assert.equal(
    resolveCommandCwdProbeMode({
      ...followVisible,
      restrictExtraSshChannels: true,
      singleChannelSsh: true,
      command: "cd ~",
    }),
    "interactive-pwd",
  );
});

test("single-channel non-cd commands do not inject pwd", () => {
  assert.equal(
    resolveCommandCwdProbeMode({
      ...followVisible,
      restrictExtraSshChannels: true,
      singleChannelSsh: true,
      command: "ls",
    }),
    "none",
  );
});

test("single-channel cd does not inject pwd when SFTP follow is hidden", () => {
  assert.equal(
    resolveCommandCwdProbeMode({
      restoreTerminalCwd: true,
      visibleSftpHost: null,
      sessionHost: { sftpFollowTerminalCwd: true },
      globalSftpFollowTerminalCwd: true,
      restrictExtraSshChannels: true,
      singleChannelSsh: true,
      command: "cd ~",
    }),
    "none",
  );
});

test("network devices never inject an interactive pwd", () => {
  assert.equal(
    resolveCommandCwdProbeMode({
      ...followVisible,
      restrictExtraSshChannels: true,
      singleChannelSsh: true,
      isNetworkDevice: true,
      command: "cd ~",
    }),
    "none",
  );
});

test("ordinary hosts still probe with exec after cd", () => {
  assert.equal(
    resolveCommandCwdProbeMode({
      ...followVisible,
      command: "cd /tmp",
    }),
    "exec",
  );
});

test("single-channel cd inside a command list uses interactive pwd", () => {
  assert.equal(
    resolveCommandCwdProbeMode({
      ...followVisible,
      restrictExtraSshChannels: true,
      singleChannelSsh: true,
      command: "cd /tmp && ls",
    }),
    "interactive-pwd",
  );
  assert.equal(
    resolveCommandCwdProbeMode({
      ...followVisible,
      restrictExtraSshChannels: true,
      singleChannelSsh: true,
      command: "cd /tmp | ls",
    }),
    "none",
  );
});
