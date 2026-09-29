declare module "./singleChannelSshBanner.shared.cjs" {
  export function remoteSoftwareRequiresSingleChannel(remoteSshVersion?: string): boolean;
  export function remoteDisallowsChunkedChannelWrite(remoteSshVersion?: string): boolean;
  export function optionsForPeerSingleChannel<T extends { singleChannelSsh?: boolean }>(
    options: T,
    conn?: { _remoteVer?: string } | null,
  ): T;
}

declare module "@/domain/singleChannelSshBanner.shared.cjs" {
  export function remoteSoftwareRequiresSingleChannel(remoteSshVersion?: string): boolean;
  export function remoteDisallowsChunkedChannelWrite(remoteSshVersion?: string): boolean;
  export function optionsForPeerSingleChannel<T extends { singleChannelSsh?: boolean }>(
    options: T,
    conn?: { _remoteVer?: string } | null,
  ): T;
}
