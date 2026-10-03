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
    const firstWord = segment.trim().split(/\s+/)[0];
    if (firstWord && CWD_CHANGING_COMMANDS.has(firstWord)) return true;
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
