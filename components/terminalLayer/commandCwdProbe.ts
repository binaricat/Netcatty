import { resolveHostFollowTerminalCwd, resolveSftpFollowTerminalCwdTargetHost } from "../sftp/sftpFollowTerminalCwd";

type FollowTerminalCwdHost = {
  sftpFollowTerminalCwd?: boolean;
};

type ShouldProbeCommandCwdOptions = {
  restoreTerminalCwd: boolean;
  visibleSftpHost?: FollowTerminalCwdHost | null;
  sessionHost?: FollowTerminalCwdHost | null;
  globalSftpFollowTerminalCwd: boolean;
};

export const shouldProbeCommandCwd = ({
  restoreTerminalCwd,
  visibleSftpHost,
  sessionHost,
  globalSftpFollowTerminalCwd,
}: ShouldProbeCommandCwdOptions): boolean => {
  if (restoreTerminalCwd) return true;

  if (!visibleSftpHost) return false;
  const followHost = resolveSftpFollowTerminalCwdTargetHost(visibleSftpHost, sessionHost);
  return resolveHostFollowTerminalCwd(
    followHost?.sftpFollowTerminalCwd,
    globalSftpFollowTerminalCwd,
  );
};
