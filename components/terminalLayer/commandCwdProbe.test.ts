import test from "node:test";
import assert from "node:assert/strict";

import { commandMayChangeCwd, shouldProbeCommandCwd } from "./commandCwdProbe";

test("commandMayChangeCwd detects cd-style commands across segments", () => {
  assert.equal(commandMayChangeCwd("cd /tmp"), true);
  assert.equal(commandMayChangeCwd("cd"), true);
  assert.equal(commandMayChangeCwd("cd -"), true);
  assert.equal(commandMayChangeCwd("pushd /var/log"), true);
  assert.equal(commandMayChangeCwd("popd"), true);
  assert.equal(commandMayChangeCwd("ls && cd /tmp"), true);
  assert.equal(commandMayChangeCwd("pwd; cd /tmp; ls"), true);
  assert.equal(commandMayChangeCwd("  cd /tmp  "), true);
});

test("commandMayChangeCwd detects wrapped, assignment-prefixed, and sourced forms", () => {
  assert.equal(commandMayChangeCwd("command cd /tmp"), true);
  assert.equal(commandMayChangeCwd("builtin cd -"), true);
  assert.equal(commandMayChangeCwd("X=1 cd /tmp"), true);
  assert.equal(commandMayChangeCwd("X=1 Y=2 pushd /var"), true);
  assert.equal(commandMayChangeCwd("env LC_ALL=C cd /tmp"), true);
  assert.equal(commandMayChangeCwd(". ./script-that-cds"), true);
  assert.equal(commandMayChangeCwd("source ~/.bashrc && ls"), true);
  assert.equal(commandMayChangeCwd("ls && command cd /tmp"), true);
  assert.equal(commandMayChangeCwd("builtin source ./setup.sh"), true);
});

test("commandMayChangeCwd rejects non-cd commands and cd lookalikes", () => {
  assert.equal(commandMayChangeCwd("ls -la"), false);
  assert.equal(commandMayChangeCwd("ls | grep build"), false);
  assert.equal(commandMayChangeCwd("echo cd /tmp"), false);
  assert.equal(commandMayChangeCwd("X=1 ls"), false);
  assert.equal(commandMayChangeCwd("command ls -la"), false);
  assert.equal(commandMayChangeCwd("cdrepo update"), false);
  assert.equal(commandMayChangeCwd("rm -rf /tmp/build"), false);
  assert.equal(commandMayChangeCwd(""), false);
  assert.equal(commandMayChangeCwd(null), false);
});

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
