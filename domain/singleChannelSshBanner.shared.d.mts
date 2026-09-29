export const SINGLE_CHANNEL_SOFTWARE_TOKENS: readonly string[];
export function remoteSoftwareRequiresSingleChannel(remoteSshVersion?: string): boolean;
export function remoteDisallowsChunkedChannelWrite(remoteSshVersion?: string): boolean;
export function optionsForPeerSingleChannel<T extends { singleChannelSsh?: boolean }>(
  options: T,
  conn?: { _remoteVer?: string } | null,
): T;
