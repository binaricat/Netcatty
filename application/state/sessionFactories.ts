import type { Host, SerialConfig, TerminalSession } from "../../domain/models";
import { classifyLocalShellType } from "../../lib/localShell";

export interface LocalTerminalOptions {
  shellType?: TerminalSession["shellType"];
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  localStartDir?: string;
}

/**
 * Stable hostId for all Local Terminal sessions.
 *
 * Autocomplete command history is keyed by hostId. Using `local-${sessionId}`
 * made every new Local Terminal look like a brand-new host, so history
 * suggestions never accumulated across opens (issue #2037).
 */
export const LOCAL_TERMINAL_HOST_ID = "local-terminal";

export const createLocalTerminalSession = (
  sessionId: string,
  options?: LocalTerminalOptions,
): TerminalSession => ({
  id: sessionId,
  hostId: LOCAL_TERMINAL_HOST_ID,
  hostLabel: options?.shellName || "Local Terminal",
  hostname: "localhost",
  username: "local",
  status: "connecting",
  protocol: "local",
  shellType: options?.shellType,
  localShell: options?.shell,
  localShellArgs: options?.shellArgs,
  localShellName: options?.shellName,
  localShellIcon: options?.shellIcon,
  localStartDir: options?.localStartDir,
});

export const snapshotSerialConfig = (
  config: SerialConfig,
  legacyBackspaceBehavior?: Host["backspaceBehavior"],
): SerialConfig => ({
  ...config,
  backspaceBehavior: config.backspaceBehavior
    ?? (legacyBackspaceBehavior === "ctrl-h" ? "ctrl-h" : "default"),
});

export const createSerialTerminalSession = (
  sessionId: string,
  config: SerialConfig,
  options?: { charset?: string },
): TerminalSession => {
  const serialConfig = snapshotSerialConfig(config);
  const portName = serialConfig.path.split("/").pop() || serialConfig.path;
  return {
    id: sessionId,
    hostId: `serial-${sessionId}`,
    hostLabel: `Serial: ${portName}`,
    hostname: serialConfig.path,
    username: "",
    status: "connecting",
    protocol: "serial",
    serialConfig,
    charset: options?.charset,
  };
};

export const createHostTerminalSession = (
  sessionId: string,
  host: Host,
): TerminalSession => {
  if (host.protocol === "serial") {
    const serialConfig = snapshotSerialConfig(
      host.serialConfig || {
        path: host.hostname,
        baudRate: host.port || 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        localEcho: false,
        lineMode: false,
      },
      host.backspaceBehavior,
    );
    const portName = serialConfig.path.split("/").pop() || serialConfig.path;
    return {
      id: sessionId,
      hostId: host.id,
      hostLabel: host.label || `Serial: ${portName}`,
      hostname: serialConfig.path,
      username: "",
      status: "connecting",
      protocol: "serial",
      serialConfig,
      charset: host.charset,
    };
  }

  return {
    id: sessionId,
    hostId: host.id,
    hostLabel: host.label,
    hostname: host.hostname,
    username: host.username,
    status: "connecting",
    protocol: host.protocol,
    pluginConnection: host.pluginConnection == null
      ? undefined
      : structuredClone(host.pluginConnection),
    port: host.port,
    moshEnabled: host.moshEnabled,
    etEnabled: host.etEnabled,
    charset: host.charset,
    // Local-shell vault hosts carry the per-host shell selection into the
    // session (the bridge resolves discovered shell ids at spawn time).
    // shellType matches ordinary local-terminal creation so captured-CWD
    // restore can reject POSIX injection into CMD/PowerShell sessions.
    ...(host.protocol === "local" ? {
      shellType: classifyLocalShellType(host.localShell, host.os),
      localShell: host.localShell,
      localShellArgs: host.localShellArgs,
      localShellName: host.localShellName,
      localShellIcon: host.localShellIcon,
      localStartDir: host.localStartDir,
    } : {}),
    ...(host.ephemeral ? { ephemeralHost: true } : {}),
    ...(host.autoOpenSftpPanel ? { autoOpenSidePanel: "sftp" as const } : {}),
  };
};

export const createWorkspaceHostTerminalSession = (
  sessionId: string,
  host: Host,
  workspaceId: string,
): TerminalSession => ({
  ...createHostTerminalSession(sessionId, host),
  workspaceId,
});
