import { useEffect, useRef } from 'react';
import type { Host } from '../../domain/models';
import { classifyDistroId, hostRestrictsExtraSshChannels } from '../../domain/host';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { createTerminalDirectoryIO } from '../../infrastructure/services/terminalDirectory';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import { registerTerminalDirectory } from './terminalDirectoryRegistry';
import { directoryChangeCommand, COMPLETE_DIRECTORY_CAPABILITIES, type WindowsDirectoryShell } from '../../domain/directoryPicker';
import type { DirectoryPathFlavor } from '../../domain/directoryPath';
import { isDiscoveredGitBash } from '../../lib/localShell.cjs';

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
  const windowsShell = shellType === 'powershell' || shellType === 'cmd' ? shellType : undefined;
  const supported = (local || ((host.protocol ?? 'ssh') === 'ssh' && !host.moshEnabled && !host.etEnabled))
    && (!windowsShell || local)
    && host.deviceType !== 'network' && classifyDistroId(host.distro) !== 'network-device'
    && !hostRestrictsExtraSshChannels(host);
  useEffect(() => {
    const bridge = netcattyBridge.get();
    const backendId = live.current.getBackendId();
    if (!bridge || !backendId || status !== 'connected' || !supported) return;
    let active = true;
    const isCurrent = () => active && live.current.status === 'connected' && live.current.getBackendId() === backendId;
    let unregister = () => {};
    const register = (pathFlavor: DirectoryPathFlavor = 'posix', integration?: WindowsDirectoryShell) => {
      if (!isCurrent()) return;
      const controller = createTerminalDirectoryController({
        sessionId,
        io: createTerminalDirectoryIO(bridge, backendId, {
          local, hostname: host.hostname, username: host.username || 'root', port: host.port,
          encoding: host.sftpEncoding,
          pathFlavor,
          windowsShell: integration,
        }, isCurrent),
        target: { authority: `${local ? 'local' : 'ssh'}:${backendId}`, pathFlavor },
        capabilities: COMPLETE_DIRECTORY_CAPABILITIES,
        buildChangeCommand: path => directoryChangeCommand(path, integration ?? 'posix', pathFlavor),
        isCurrent,
        isReady: () => live.current.isReady(),
        publish: cwd => live.current.publish(cwd),
      });
      unregister = registerTerminalDirectory(sessionId, controller);
    };
    if (local) {
      void bridge.getAppInfo?.().then(async info => {
        if ((info.platform === 'darwin' || info.platform === 'linux') && !windowsShell) register();
        if (info.platform !== 'win32' || !isCurrent()) return;
        if (windowsShell) register('win32', windowsShell);
        else if (shellType === 'posix' && host.localShell) {
          const shells = await bridge.discoverShells?.();
          if (isDiscoveredGitBash(host.localShell, shells?.find(item => item.id === 'git-bash')?.command)) {
            register('win32', 'git-bash');
          }
        }
      }).catch(() => {});
    } else register();
    return () => { active = false; unregister(); };
  }, [sessionId, status, supported, local, host.hostname, host.username, host.port, host.sftpEncoding, host.localShell, shellType, windowsShell]);
}
