import type { Host, SerialConfig, TerminalSession } from "../../domain/models";

export interface LocalTerminalOptions {
  shellType?: TerminalSession["shellType"];
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
}

export const createLocalTerminalSession = (
  sessionId: string,
  options?: LocalTerminalOptions,
): TerminalSession => ({
  id: sessionId,
  hostId: `local-${sessionId}`,
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
});

export const createSerialTerminalSession = (
  sessionId: string,
  config: SerialConfig,
  options?: { charset?: string },
): TerminalSession => {
  const portName = config.path.split("/").pop() || config.path;
  return {
    id: sessionId,
    hostId: `serial-${sessionId}`,
    hostLabel: `Serial: ${portName}`,
    hostname: config.path,
    username: "",
    status: "connecting",
    protocol: "serial",
    serialConfig: config,
    charset: options?.charset,
  };
};

export const createHostTerminalSession = (
  sessionId: string,
  host: Host,
): TerminalSession => {
  if (host.protocol === "serial") {
    const serialConfig: SerialConfig = host.serialConfig || {
      path: host.hostname,
      baudRate: host.port || 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      localEcho: false,
      lineMode: false,
    };
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
    port: host.port,
    moshEnabled: host.moshEnabled,
    etEnabled: host.etEnabled,
    charset: host.charset,
  };
};
