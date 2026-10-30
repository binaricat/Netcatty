import { DirectoryPickerError, directoryEntries, isDirectoryPath } from '../../domain/directoryPicker';
import { shouldProbeSessionCwd } from '../../domain/host';

export interface TerminalDirectoryIO {
  cwd(): Promise<string>;
  home?(): Promise<string | null>;
  list(path: string, signal?: AbortSignal): Promise<{ entries: ReturnType<typeof directoryEntries>; home: string | null }>;
  realpath(path: string, signal?: AbortSignal): Promise<string>;
  write(data: string): void;
}

/** Uses the exact authenticated terminal transport; never dials another host. */
export function createTerminalDirectoryIO(bridge: NetcattyBridge, sessionId: string,
  endpoint: { local: boolean; hostname: string; username: string; port?: number; encoding?: import('../../types').SftpFilenameEncoding },
  isCurrent: () => boolean = () => true,
): TerminalDirectoryIO {
  const check = (signal?: AbortSignal) => { if (!isCurrent() || signal?.aborted) throw new DirectoryPickerError('unavailable'); };
  async function checkRemote(signal?: AbortSignal) {
    check(signal);
    const info = await bridge.getSessionRemoteInfo?.(sessionId);
    check(signal);
    if (!info?.success || info.singleChannelSsh || !shouldProbeSessionCwd({ isNetworkDevice: false, remoteSshVersion: info.remoteSshVersion })) {
      throw new DirectoryPickerError('unavailable');
    }
  }
  async function withSftp<T>(run: (id: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await checkRemote(signal);
    if (!bridge.openSftpForSession) throw new DirectoryPickerError('unavailable');
    const id = await bridge.openSftpForSession(sessionId, {
      hostname: endpoint.hostname, username: endpoint.username, port: endpoint.port,
      requireExactSourceSession: true, fileProtocol: 'sftp',
    });
    try { check(signal); return await run(id); }
    finally { await bridge.closeSftp(id).catch(() => {}); }
  }
  return {
    async home() { check(); return endpoint.local ? await bridge.getHomeDir?.().catch(() => null) ?? null : null; },
    async cwd() {
      check();
      if (!endpoint.local) await checkRemote();
      const result = await bridge.getSessionPwd?.(sessionId, {
        allowHomeFallback: false, allowLoginShellFallback: false, timeoutMs: 2000,
      });
      if (!result?.success || !isDirectoryPath(result.cwd)) throw new DirectoryPickerError('unknown');
      return result.cwd;
    },
    async list(path, signal) {
      check(signal);
      if (!isDirectoryPath(path)) throw new DirectoryPickerError('unsupportedPath');
      if (endpoint.local) {
        const files = await bridge.listLocalDir(path);
        check(signal);
        const home = await bridge.getHomeDir?.().catch(() => null) ?? null;
        return { entries: directoryEntries(path, files), home };
      }
      return withSftp(async id => {
        const files = await bridge.listSftp(id, path, endpoint.encoding);
        // SFTP's login directory may be a chroot root, so do not guess remote HOME.
        return { entries: directoryEntries(path, files), home: null };
      }, signal);
    },
    async realpath(path, signal) {
      check(signal);
      return endpoint.local ? await bridge.realpathLocal?.(path) ?? path
        : withSftp(async id => await bridge.realpathSftp?.(id, path, endpoint.encoding) ?? path, signal);
    },
    write(data) { check(); bridge.writeToSession(sessionId, data, { automated: true }); },
  };
}
