import { commandReportsDirectoryChange } from "../../domain/posixCwdFromCommand";
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

export type CommandCwdProbeMode = "none" | "exec" | "interactive-pwd";

type ResolveCommandCwdProbeModeOptions = ShouldProbeCommandCwdOptions & {
  singleChannelSsh?: boolean;
  isNetworkDevice?: boolean;
  command: string;
};

/**
 * 普通主机在命令后开 exec 探测目录。单通道堡垒机不能再开 channel，
 * 只在 cd/pushd/popd（含 &&、;、||）且 SFTP 正在跟随时，
 * 等整行结束后往当前交互 shell 补一次 pwd。管道和后台命令不注入。
 * 网络设备不能注入命令。
 */
export const resolveCommandCwdProbeMode = ({
  singleChannelSsh = false,
  isNetworkDevice = false,
  command,
  ...probeOptions
}: ResolveCommandCwdProbeModeOptions): CommandCwdProbeMode => {
  if (
    singleChannelSsh
    && !isNetworkDevice
    && commandReportsDirectoryChange(command)
  ) {
    const followWantsProbe = shouldProbeCommandCwd({
      ...probeOptions,
      restoreTerminalCwd: false,
      restrictExtraSshChannels: false,
    });
    if (followWantsProbe) return "interactive-pwd";
  }
  return shouldProbeCommandCwd(probeOptions) ? "exec" : "none";
};
