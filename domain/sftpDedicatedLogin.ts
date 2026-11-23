import { detectVendorFromSshVersion, hostRestrictsExtraSshChannels } from "./host";
import type { Host } from "./models";
import { remoteSoftwareRequiresSingleChannel } from "@/domain/singleChannelSshBanner.shared.cjs";

export type SftpDedicatedLoginInput = {
  host?: Pick<Host, "deviceType"> | null;
  remoteSshVersion?: string | null;
};

/**
 * SFTP must dial its own SSH login when an extra subsystem on the terminal
 * TCP session would drop the shell (#3631).
 *
 * Network-device mode is enough on its own, with or without a banner.
 * A network-vendor identification string (Huawei `-` / `SSH-2.0--`, Ruijie
 * RGOS, and the other `detectVendorFromSshVersion` matches) and one-channel
 * bastion software tokens are included here. This does not stamp
 * session.singleChannelSsh; that flag stays reserved for bastion banners.
 */
export function sftpRequiresDedicatedLogin(input: SftpDedicatedLoginInput): boolean {
  if (hostRestrictsExtraSshChannels(input.host)) return true;
  const remoteSshVersion = input.remoteSshVersion || undefined;
  return remoteSoftwareRequiresSingleChannel(remoteSshVersion)
    || detectVendorFromSshVersion(remoteSshVersion) !== "";
}
