import { DirectoryPickerError, directoryEntries, isDirectoryPath } from '../../domain/directoryPicker';
import { shouldProbeSessionCwd } from '../../domain/host';
import { sameDirectoryPath, type DirectoryPathFlavor } from '../../domain/directoryPath';

export interface TerminalDirectoryIO {
  cwd(): Promise<string>;
  home?(): Promise<string | null>;
  list(path: string, signal?: AbortSignal): Promise<{ entries: ReturnType<typeof directoryEntries>; home: string | null }>;
  realpath(path: string, signal?: AbortSignal): Promise<string>;
  validateChange?(expectedCwd?: string): Promise<void>;
  write(data: string): void;
}

/** Uses the exact authenticated terminal transport; never dials another host. */
export function createTerminalDirectoryIO(bridge: NetcattyBridge, sessionId: string,
  endpoint: { local: boolean; hostname: string; username: string; port?: number; encoding?: import('../../types').SftpFilenameEncoding;
    pathFlavor?: DirectoryPathFlavor },
  isCurrent: () => boolean = () => true,
): TerminalDirectoryIO {
  const check = (signal?: AbortSignal) => { if (!isCurrent() || signal?.aborted) throw new DirectoryPickerError('unavailable'); };
  const flavor = endpoint.pathFlavor ?? 'posix';
  const nativeWindows = endpoint.local && flavor === 'win32';
  let lastNativeRevision = 0;
  let submittedNativeRevision = -1;
  const valid = (path: string | null | undefined): path is string => isDirectoryPath(path, flavor);
  async function readNative() {
    check();
    const result = await bridge.getSessionPwd?.(sessionId, {
      allowHomeFallback: false, allowLoginShellFallback: false, timeoutMs: 2000,
    });
    check();
    const state = result?.directoryState;
    if (!state || state.shellKind !== 'powershell' || state.pathFlavor !== 'win32') throw new DirectoryPickerError('integrationUnavailable');
    if (state.provider !== 'FileSystem') throw new DirectoryPickerError('nonFilesystem');
    if (!result.success || !valid(result.cwd) || !Number.isSafeInteger(state.revision)
      || state.revision < lastNativeRevision || state.revision <= submittedNativeRevision) throw new DirectoryPickerError('unknown');
    lastNativeRevision = state.revision;
    return { cwd: result.cwd, home: valid(state.home) ? state.home : null };
  }
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
      requireExactSourceSession: true, reuseExactSessionOnly: true, fileProtocol: 'sftp',
    });
    try { check(signal); return await run(id); }
    finally { await bridge.closeSftp(id).catch(() => {}); }
  }
  return {
    async home() {
      check();
      if (nativeWindows) return (await readNative()).home;
      return endpoint.local ? await bridge.getHomeDir?.().catch(() => null) ?? null : null;
    },
    async cwd() {
      check();
      if (nativeWindows) return (await readNative()).cwd;
      if (!endpoint.local) await checkRemote();
      const result = await bridge.getSessionPwd?.(sessionId, {
        allowHomeFallback: false, allowLoginShellFallback: false, timeoutMs: 2000,
      });
      check();
      if (!result?.success || !valid(result.cwd)) throw new DirectoryPickerError('unknown');
      return result.cwd;
    },
    async list(path, signal) {
      check(signal);
      if (!valid(path)) throw new DirectoryPickerError('unsupportedPath');
      if (endpoint.local) {
        const native = nativeWindows ? await readNative() : null;
        const files = await bridge.listLocalDir(path);
        check(signal);
        const home = nativeWindows ? native!.home : await bridge.getHomeDir?.().catch(() => null) ?? null;
        check(signal);
        return { entries: directoryEntries(path, files, flavor), home };
      }
      return withSftp(async id => {
        const files = await bridge.listSftp(id, path, endpoint.encoding);
        // SFTP's login directory may be a chroot root, so do not guess remote HOME.
        return { entries: directoryEntries(path, files), home: null };
      }, signal);
    },
    async realpath(path, signal) {
      check(signal);
      if (!valid(path)) throw new DirectoryPickerError('unsupportedPath');
      if (nativeWindows) await readNative();
      const result = endpoint.local ? await bridge.realpathLocal?.(path) ?? path
        : withSftp(async id => await bridge.realpathSftp?.(id, path, endpoint.encoding) ?? path, signal);
      const resolved = await result;
      check(signal);
      if (!valid(resolved)) throw new DirectoryPickerError('unsupportedPath');
      return resolved;
    },
    async validateChange(expectedCwd) {
      if (!nativeWindows) return;
      const native = await readNative();
      if (expectedCwd && !sameDirectoryPath(native.cwd, expectedCwd, flavor)) throw new DirectoryPickerError('unavailable');
    },
    write(data) {
      check();
      if (nativeWindows) submittedNativeRevision = lastNativeRevision;
      bridge.writeToSession(sessionId, data, { automated: true });
    },
  };
}
