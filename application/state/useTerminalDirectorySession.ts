import { useEffect, useRef } from 'react';
import type { Host } from '../../domain/models';
import { classifyDistroId, hostRestrictsExtraSshChannels } from '../../domain/host';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { createTerminalDirectoryIO } from '../../infrastructure/services/terminalDirectory';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import { registerTerminalDirectory } from './terminalDirectoryRegistry';

export function useTerminalDirectorySession(options: {
  sessionId: string;
  status: string;
  host: Host;
  shellType?: string;
  getBackendId: () => string | null;
  isReady: () => boolean;
  publish: (cwd: string) => void;
}) {
  const live = useRef(options);
  live.current = options;
  const { sessionId, status, shellType, host } = options;
  const local = host.protocol === 'local';
  const supported = (local || ((host.protocol ?? 'ssh') === 'ssh' && !host.moshEnabled && !host.etEnabled))
    && shellType !== 'powershell' && shellType !== 'cmd'
    && host.deviceType !== 'network' && classifyDistroId(host.distro) !== 'network-device'
    && !hostRestrictsExtraSshChannels(host);
  useEffect(() => {
    const bridge = netcattyBridge.get();
    const backendId = live.current.getBackendId();
    if (!bridge || !backendId || status !== 'connected' || !supported) return;
    let active = true;
    const isCurrent = () => active && live.current.status === 'connected' && live.current.getBackendId() === backendId;
    let unregister = () => {};
    const register = () => {
      if (!isCurrent()) return;
      const controller = createTerminalDirectoryController({
        sessionId,
        io: createTerminalDirectoryIO(bridge, backendId, {
          local, hostname: host.hostname, username: host.username || 'root', port: host.port,
          encoding: host.sftpEncoding,
        }, isCurrent),
        isCurrent,
        isReady: () => live.current.isReady(),
        publish: cwd => live.current.publish(cwd),
      });
      unregister = registerTerminalDirectory(sessionId, controller);
    };
    if (local) {
      // POSIX wrappers on Windows still use win32 PTYs. Neither their cwd nor
      // their path namespace is supported by readLocalSessionCwd/local FS.
      void bridge.getAppInfo?.().then(info => {
        if (info.platform === 'darwin' || info.platform === 'linux') register();
      }).catch(() => {});
    } else register();
    return () => { active = false; unregister(); };
  }, [sessionId, status, supported, local, host.hostname, host.username, host.port, host.sftpEncoding, shellType]);
}
