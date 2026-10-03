import { resolveHostFollowTerminalCwd, resolveSftpFollowTerminalCwdTargetHost } from "../../domain/sftpFollowTerminalCwd";

type FollowTerminalCwdHost = {
  sftpFollowTerminalCwd?: boolean;
};

type ShouldProbeCommandCwdOptions = {
  restoreTerminalCwd: boolean;
  visibleSftpHost?: FollowTerminalCwdHost | null;
  sessionHost?: FollowTerminalCwdHost | null;
  globalSftpFollowTerminalCwd: boolean;
  restrictExtraSshChannels?: boolean;
};

const CWD_CHANGING_COMMANDS = new Set(["cd", "pushd", "popd"]);
// Wrappers that run their argument in the (effective) shell context, so a
// wrapped `cd` still moves the interactive shell's cwd.
const CWD_PASS_THROUGH_WRAPPERS = new Set(["command", "builtin", "env"]);
// Sourced scripts execute in the interactive shell itself, so they may
// legitimately change its cwd. Over-detection here is cheap (one extra retry);
// under-detection publishes a stale pre-command cwd.
const SOURCING_COMMANDS = new Set([".", "source"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether a submitted command text plausibly changes the interactive shell's
 * cwd. Used to decide whether the post-command backend pwd probe must guard
 * against a stale read that raced the remote execution: `cd /x` on a slow link
 * can still be in flight when the probe runs, so its result needs a retry.
 */
export const commandMayChangeCwd = (command?: string | null): boolean => {
  if (!command) return false;
  // Segment on command separators so `ls && cd /tmp` is caught while
  // `echo cd /tmp` is not.
  for (const segment of command.split(/&&|\|\||[;|]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Skip leading env assignments: `X=1 cd /tmp` runs `cd` in the shell.
    if (words.length && ENV_ASSIGNMENT.test(words[0])) {
      while (words.length && ENV_ASSIGNMENT.test(words[0])) words.shift();
    }
    if (!words.length) continue;
    const firstWord = words[0];
    if (CWD_CHANGING_COMMANDS.has(firstWord)) return true;
    if (SOURCING_COMMANDS.has(firstWord)) return true;
    // `command cd /tmp` / `builtin cd /tmp` bypass aliases/functions but the
    // resulting `cd` still changes the shell's cwd.
    if (CWD_PASS_THROUGH_WRAPPERS.has(firstWord)) {
      words.shift();
      // `env FOO=bar cd /tmp` interleaves more assignments after the wrapper.
      while (words.length && ENV_ASSIGNMENT.test(words[0])) words.shift();
      const nextWord = words[0];
      if (nextWord) {
        if (CWD_CHANGING_COMMANDS.has(nextWord)) return true;
        if (SOURCING_COMMANDS.has(nextWord)) return true;
      }
    }
  }
  return false;
};

export const shouldProbeCommandCwd = ({
  restoreTerminalCwd,
  visibleSftpHost,
  sessionHost,
  globalSftpFollowTerminalCwd,
  restrictExtraSshChannels = false,
}: ShouldProbeCommandCwdOptions): boolean => {
  if (restrictExtraSshChannels) return false;
  if (restoreTerminalCwd) return true;

  if (!visibleSftpHost) return false;
  const followHost = resolveSftpFollowTerminalCwdTargetHost(visibleSftpHost, sessionHost);
  return resolveHostFollowTerminalCwd(
    followHost?.sftpFollowTerminalCwd,
    globalSftpFollowTerminalCwd,
  );
};
