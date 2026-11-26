import type {
  Host,
  HostChainConfig,
  Identity,
  ProxyConfig,
  RdpColorDepth,
  RdpConfig,
  RdpResolutionMode,
  RdpSecurityMode,
  VncConfig,
  VncScalingMode,
} from './models/connection';
import { isPluginHostProtocol } from './pluginConnection';

export type RemoteDesktopProtocol = 'vnc' | 'rdp';

export const DEFAULT_RDP_PORT = 3389;
export const DEFAULT_VNC_PORT = 5900;

export const DEFAULT_RDP_WIDTH = 1920;
export const DEFAULT_RDP_HEIGHT = 1080;
export const DEFAULT_RDP_COLOR_DEPTH: RdpColorDepth = 32;
export const DEFAULT_RDP_RESOLUTION_MODE: RdpResolutionMode = 'dynamic';
export const DEFAULT_RDP_SECURITY_MODE: RdpSecurityMode = 'auto';

export const DEFAULT_VNC_SCALING_MODE: VncScalingMode = 'fit';
export const DEFAULT_VNC_QUALITY = 6;
export const DEFAULT_VNC_COMPRESSION_LEVEL = 2;

export type NormalizedRdpConfig = RdpConfig & {
  port: number;
  resolutionMode: RdpResolutionMode;
  width: number;
  height: number;
  colorDepth: RdpColorDepth;
  audioEnabled: boolean;
  clipboardSync: boolean;
  clipboardFilesEnabled: boolean;
  securityMode: RdpSecurityMode;
  ignoreCertErrors: boolean;
};

export type NormalizedVncConfig = VncConfig & {
  port: number;
  scalingMode: VncScalingMode;
  quality: number;
  compressionLevel: number;
  viewOnly: boolean;
  sharedSession: boolean;
  clipboardSync: boolean;
  showRemoteCursor: boolean;
};

export const DEFAULT_RDP_CONFIG: Readonly<NormalizedRdpConfig> = {
  port: DEFAULT_RDP_PORT,
  resolutionMode: DEFAULT_RDP_RESOLUTION_MODE,
  width: DEFAULT_RDP_WIDTH,
  height: DEFAULT_RDP_HEIGHT,
  colorDepth: DEFAULT_RDP_COLOR_DEPTH,
  audioEnabled: true,
  clipboardSync: true,
  clipboardFilesEnabled: true,
  securityMode: DEFAULT_RDP_SECURITY_MODE,
  ignoreCertErrors: false,
};

export const DEFAULT_VNC_CONFIG: Readonly<NormalizedVncConfig> = {
  port: DEFAULT_VNC_PORT,
  scalingMode: DEFAULT_VNC_SCALING_MODE,
  quality: DEFAULT_VNC_QUALITY,
  compressionLevel: DEFAULT_VNC_COMPRESSION_LEVEL,
  viewOnly: false,
  sharedSession: true,
  clipboardSync: true,
  showRemoteCursor: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isValidPort = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
);

const readTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readBoolean = (value: unknown): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

const clampInt = (value: unknown, min: number, max: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const isRdpResolutionMode = (value: unknown): value is RdpResolutionMode => (
  value === 'dynamic' || value === 'fit' || value === 'fixed'
);

const isRdpColorDepth = (value: unknown): value is RdpColorDepth => (
  value === 16 || value === 24 || value === 32
);

const isRdpSecurityMode = (value: unknown): value is RdpSecurityMode => (
  value === 'auto' || value === 'nla' || value === 'tls' || value === 'rdp'
);

const isVncScalingMode = (value: unknown): value is VncScalingMode => (
  value === 'fit' || value === 'actual' || value === 'stretch' || value === 'dynamic'
);

export const isVncProtocol = (protocol?: string | null): protocol is 'vnc' => (
  typeof protocol === 'string' && protocol.toLowerCase() === 'vnc'
);

export const isRdpProtocol = (protocol?: string | null): protocol is 'rdp' => (
  typeof protocol === 'string' && protocol.toLowerCase() === 'rdp'
);

export const isRemoteDesktopProtocol = (
  protocol?: string | null,
): protocol is RemoteDesktopProtocol => (
  isVncProtocol(protocol) || isRdpProtocol(protocol)
);

const canHostHaveCompanionDesktop = (
  host?: Pick<Host, 'protocol'> | null,
): boolean => {
  if (!host) return false;
  if (host.protocol === 'local' || host.protocol === 'serial') return false;
  if (isPluginHostProtocol(host.protocol)) return false;
  return true;
};

export const hasCompanionVnc = (
  host?: Pick<Host, 'protocol' | 'vncConfig'> | null,
): boolean => (
  canHostHaveCompanionDesktop(host)
  && !isVncProtocol(host?.protocol)
  && host?.vncConfig?.enabled === true
);

export const hasCompanionRdp = (
  host?: Pick<Host, 'protocol' | 'rdpConfig'> | null,
): boolean => (
  canHostHaveCompanionDesktop(host)
  && !isRdpProtocol(host?.protocol)
  && host?.rdpConfig?.enabled === true
);

export const getAvailableRemoteDesktopProtocols = (
  host?: Pick<Host, 'protocol' | 'vncConfig' | 'rdpConfig'> | null,
): RemoteDesktopProtocol[] => {
  if (!host) return [];
  const result: RemoteDesktopProtocol[] = [];
  if (isRdpProtocol(host.protocol)) {
    result.push('rdp');
  } else if (isVncProtocol(host.protocol)) {
    result.push('vnc');
  }
  if (hasCompanionRdp(host) && !result.includes('rdp')) {
    result.push('rdp');
  }
  if (hasCompanionVnc(host) && !result.includes('vnc')) {
    result.push('vnc');
  }
  return result;
};

export type EditableHostProtocol = 'ssh' | 'rdp' | 'vnc' | 'telnet';

/**
 * List the built-in interactive protocols enabled on a host (SSH, RDP, VNC, Telnet).
 * Returns an empty list for local-shell, serial, and plugin-backed hosts.
 */
export const getHostEnabledProtocols = (
  host?: Pick<Host, 'protocol' | 'telnetEnabled' | 'rdpConfig' | 'vncConfig' | 'protocols'> | null,
): EditableHostProtocol[] => {
  if (!host) return [];
  if (
    host.protocol === 'local' ||
    host.protocol === 'serial' ||
    (typeof host.protocol === 'string' && host.protocol.startsWith('plugin:'))
  ) {
    return [];
  }
  const enabled: EditableHostProtocol[] = [];
  const hasSsh =
    !host.protocol ||
    host.protocol === 'ssh' ||
    host.protocol === 'mosh' ||
    host.protocol === 'et' ||
    Boolean(host.protocols?.some((p) => p.protocol === 'ssh' && p.enabled));
  if (hasSsh) enabled.push('ssh');
  if (host.protocol === 'rdp' || host.rdpConfig?.enabled === true) enabled.push('rdp');
  if (host.protocol === 'vnc' || host.vncConfig?.enabled === true) enabled.push('vnc');
  if (
    host.protocol === 'telnet' ||
    host.telnetEnabled === true ||
    Boolean(host.protocols?.some((p) => p.protocol === 'telnet' && p.enabled))
  ) {
    enabled.push('telnet');
  }
  return enabled;
};

/**
 * Resolve which protocol should launch when double-clicking / default-connecting a host.
 * Supports SSH hosts whose companion RDP/VNC is flagged `defaultConnect: true`
 * without breaking SSH port/keys or iOS SSH availability.
 */
export const resolveHostDefaultConnectProtocol = (
  host?: Pick<Host, 'protocol' | 'vncConfig' | 'rdpConfig'> | null,
): EditableHostProtocol => {
  if (!host) return 'ssh';
  if (host.protocol === 'rdp') return 'rdp';
  if (host.protocol === 'vnc') return 'vnc';
  if (host.protocol === 'telnet') return 'telnet';
  if (!host.protocol || host.protocol === 'ssh' || host.protocol === 'mosh' || host.protocol === 'et') {
    if (host.rdpConfig?.enabled && host.rdpConfig?.defaultConnect) return 'rdp';
    if (host.vncConfig?.enabled && host.vncConfig?.defaultConnect) return 'vnc';
  }
  return 'ssh';
};

/**
 * Decide whether double-clicking / default-connecting a host should open ProtocolSelectDialog.
 * Preserves 100% legacy behavior when `connectProtocolBehavior` is undefined:
 * - Legacy SSH + Telnet (telnetEnabled) prompts unless a companion desktop is default.
 * - Legacy SSH + VNC/RDP connects directly to the default protocol unless `connectProtocolBehavior === 'ask'`.
 */
export const shouldPromptHostProtocolOnConnect = (
  host?: Pick<
    Host,
    'protocol' | 'telnetEnabled' | 'rdpConfig' | 'vncConfig' | 'protocols' | 'connectProtocolBehavior'
  > | null,
): boolean => {
  if (!host) return false;
  if (
    host.protocol === 'local' ||
    host.protocol === 'serial' ||
    (typeof host.protocol === 'string' && host.protocol.startsWith('plugin:'))
  ) {
    return false;
  }
  const enabled = getHostEnabledProtocols(host);
  if (enabled.length < 2) return false;
  if (host.connectProtocolBehavior === 'ask') return true;
  if (host.connectProtocolBehavior === 'default') return false;

  const effectiveProtocol = host.protocol ?? 'ssh';
  const hasCompanionDesktopDefault =
    effectiveProtocol === 'ssh' &&
    Boolean(
      (host.rdpConfig?.enabled && host.rdpConfig?.defaultConnect) ||
        (host.vncConfig?.enabled && host.vncConfig?.defaultConnect),
    );
  if (hasCompanionDesktopDefault) return false;
  return effectiveProtocol === 'ssh' && Boolean(host.telnetEnabled);
};

/**
 * Update a host's default connect protocol while preserving all enabled protocols
 * (including SSH when switching an SSH + Telnet host's default to Telnet).
 */
export const applyHostDefaultConnectProtocol = (
  host: Host,
  protocol: 'ssh' | 'mosh' | 'et' | 'rdp' | 'vnc' | 'telnet',
): Host => {
  const enabled = getHostEnabledProtocols(host);
  const hasSsh = enabled.includes('ssh');
  const nextBehavior = enabled.length >= 2 ? ('default' as const) : undefined;
  const clearDesktopDefaults = {
    ...(host.rdpConfig ? { rdpConfig: { ...host.rdpConfig, defaultConnect: undefined } } : {}),
    ...(host.vncConfig ? { vncConfig: { ...host.vncConfig, defaultConnect: undefined } } : {}),
  };

  if (protocol === 'ssh' || protocol === 'mosh' || protocol === 'et') {
    const savedSshPort = host.protocols?.find((p) => p.protocol === 'ssh')?.port;
    return {
      ...host,
      ...clearDesktopDefaults,
      protocol: 'ssh',
      ...(host.protocol === 'telnet' && savedSshPort ? { port: savedSshPort } : {}),
      ...(protocol === 'mosh' ? { moshEnabled: true, etEnabled: false } : {}),
      ...(protocol === 'et' ? { etEnabled: true, moshEnabled: false } : {}),
      connectProtocolBehavior: nextBehavior,
    };
  }

  if (protocol === 'telnet') {
    const existingProtocols = host.protocols ?? [];
    const sshEntryExists = existingProtocols.some((p) => p.protocol === 'ssh');
    const nextProtocols = hasSsh
      ? sshEntryExists
        ? existingProtocols.map((p) =>
            p.protocol === 'ssh' ? { ...p, enabled: true, port: p.port || host.port || 22 } : p,
          )
        : [...existingProtocols, { protocol: 'ssh' as const, port: host.port || 22, enabled: true }]
      : host.protocols;
    return {
      ...host,
      ...clearDesktopDefaults,
      protocol: 'telnet',
      telnetEnabled: true,
      ...(nextProtocols ? { protocols: nextProtocols } : {}),
      connectProtocolBehavior: nextBehavior,
    };
  }

  if (protocol === 'rdp') {
    if (hasSsh) {
      return {
        ...host,
        protocol: 'ssh',
        ...(host.vncConfig ? { vncConfig: { ...host.vncConfig, defaultConnect: undefined } } : {}),
        rdpConfig: {
          ...DEFAULT_RDP_CONFIG,
          ...(host.rdpConfig ?? {}),
          enabled: true,
          defaultConnect: true,
        },
        connectProtocolBehavior: nextBehavior,
      };
    }
    return { ...host, ...clearDesktopDefaults, protocol: 'rdp', connectProtocolBehavior: nextBehavior };
  }

  if (protocol === 'vnc') {
    if (hasSsh) {
      return {
        ...host,
        protocol: 'ssh',
        ...(host.rdpConfig ? { rdpConfig: { ...host.rdpConfig, defaultConnect: undefined } } : {}),
        vncConfig: {
          ...DEFAULT_VNC_CONFIG,
          ...(host.vncConfig ?? {}),
          enabled: true,
          defaultConnect: true,
        },
        connectProtocolBehavior: nextBehavior,
      };
    }
    return { ...host, ...clearDesktopDefaults, protocol: 'vnc', connectProtocolBehavior: nextBehavior };
  }

  return host;
};

/**
 * Build the connect dispatch payload for an explicit protocol pick (e.g. from ProtocolSelectDialog).
 * Keeps companion SSH host identity intact when launching RDP/VNC so SSH tunneling and
 * inherited host credentials keep working, and clears `defaultConnect` on transient SSH/Telnet
 * launches so session creation doesn't hijack back to a companion desktop.
 */
export const buildHostForProtocolOverride = (
  host: Host,
  protocol: Host['protocol'] & string,
  port: number,
):
  | { mode: 'remoteDesktop'; protocol: RemoteDesktopProtocol; host: Host }
  | { mode: 'connect'; host: Host } => {
  const enabled = getHostEnabledProtocols(host);
  const hasSsh = enabled.includes('ssh');

  if (protocol === 'rdp' || protocol === 'vnc') {
    if (hasSsh && host.protocol !== protocol) {
      const updatedHost: Host =
        protocol === 'rdp'
          ? {
              ...host,
              protocol: 'ssh',
              rdpConfig: {
                ...DEFAULT_RDP_CONFIG,
                ...(host.rdpConfig ?? {}),
                enabled: true,
                port,
              },
            }
          : {
              ...host,
              protocol: 'ssh',
              vncConfig: {
                ...DEFAULT_VNC_CONFIG,
                ...(host.vncConfig ?? {}),
                enabled: true,
                port,
              },
            };
      return { mode: 'remoteDesktop', protocol, host: updatedHost };
    }
    return {
      mode: 'connect',
      host: {
        ...host,
        protocol,
        port,
        ...(protocol === 'rdp'
          ? { rdpConfig: { ...DEFAULT_RDP_CONFIG, ...(host.rdpConfig ?? {}), port } }
          : { vncConfig: { ...DEFAULT_VNC_CONFIG, ...(host.vncConfig ?? {}), port } }),
      },
    };
  }

  const clearDesktopDefaults = {
    ...(host.rdpConfig ? { rdpConfig: { ...host.rdpConfig, defaultConnect: undefined } } : {}),
    ...(host.vncConfig ? { vncConfig: { ...host.vncConfig, defaultConnect: undefined } } : {}),
  };

  if (protocol === 'telnet') {
    return {
      mode: 'connect',
      host: {
        ...host,
        ...clearDesktopDefaults,
        protocol: 'telnet',
        port,
        telnetPort: port,
        moshEnabled: false,
        etEnabled: false,
      },
    };
  }

  return {
    mode: 'connect',
    host: {
      ...host,
      ...clearDesktopDefaults,
      protocol: protocol === 'mosh' || protocol === 'et' ? 'ssh' : protocol,
      port,
      moshEnabled: protocol === 'mosh',
      etEnabled: protocol === 'et',
    },
  };
};

/**
 * Parse a VNC TCP port or X11/VNC display number (`:0`..`:99` or `0`..`99` <-> `5900 + N`).
 * Returns `null` for invalid or out-of-range inputs.
 */
export const parseVncPortOrDisplay = (
  input: string | number | null | undefined,
): number | null => {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 65535) return null;
    return input <= 99 ? DEFAULT_VNC_PORT + input : input;
  }
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(':')) {
    const displayStr = trimmed.slice(1);
    if (!/^\d{1,2}$/.test(displayStr)) return null;
    const display = Number(displayStr);
    if (!Number.isInteger(display) || display < 0 || display > 99) return null;
    return DEFAULT_VNC_PORT + display;
  }

  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return null;
  return parsed <= 99 ? DEFAULT_VNC_PORT + parsed : parsed;
};

/**
 * Format a VNC TCP port in `5900..5999` as its `:N` display number, or `null`
 * if outside the standard display range.
 */
export const formatVncDisplayNumber = (port: number): string | null => {
  if (!Number.isInteger(port) || port < DEFAULT_VNC_PORT || port > DEFAULT_VNC_PORT + 99) {
    return null;
  }
  return `:${port - DEFAULT_VNC_PORT}`;
};

/**
 * Split Windows `DOMAIN\username` into `{ domain, username }`.
 *
 * CRITICAL: Only splits on backslash (`\`). JumpServer Razor tokens use
 * `user|token_uuid` and UPNs use `user@corp.example` — both MUST be preserved
 * verbatim as `username`.
 */
export const splitWindowsUserDomain = (
  username?: string | null,
  explicitDomain?: string | null,
): { username: string; domain: string } => {
  const rawUser = typeof username === 'string' ? username.trim() : '';
  const cleanExplicitDomain = typeof explicitDomain === 'string' ? explicitDomain.trim() : '';

  const backslashIdx = rawUser.indexOf('\\');
  if (backslashIdx !== -1) {
    const parsedDomain = rawUser.slice(0, backslashIdx).trim();
    const parsedUser = rawUser.slice(backslashIdx + 1).trim();
    return {
      domain: cleanExplicitDomain || parsedDomain,
      username: parsedUser,
    };
  }

  return {
    domain: cleanExplicitDomain,
    username: rawUser,
  };
};

/**
 * Strictly allowlist non-sensitive `RdpConfig` fields.
 * Never retains plaintext `password` or unknown properties.
 */
export const sanitizeRdpConfig = (value: unknown): RdpConfig | undefined => {
  if (!isRecord(value)) return undefined;

  const out: RdpConfig = {};
  const enabled = readBoolean(value.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const defaultConnect = readBoolean(value.defaultConnect);
  if (defaultConnect !== undefined) out.defaultConnect = defaultConnect;
  if (isValidPort(value.port)) out.port = value.port;
  const domain = readTrimmedString(value.domain);
  if (domain !== undefined) out.domain = domain;
  const identityId = readTrimmedString(value.identityId);
  if (identityId !== undefined) out.identityId = identityId;
  const username = readTrimmedString(value.username);
  if (username !== undefined) out.username = username;
  const useHostCredentials = readBoolean(value.useHostCredentials);
  if (useHostCredentials !== undefined) out.useHostCredentials = useHostCredentials;
  const tunnelViaHostSsh = readBoolean(value.tunnelViaHostSsh);
  if (tunnelViaHostSsh !== undefined) out.tunnelViaHostSsh = tunnelViaHostSsh;
  const tunnelTargetHost = readTrimmedString(value.tunnelTargetHost);
  if (tunnelTargetHost !== undefined) out.tunnelTargetHost = tunnelTargetHost;
  if (isRdpResolutionMode(value.resolutionMode)) out.resolutionMode = value.resolutionMode;
  const width = clampInt(value.width, 200, 8192);
  if (width !== undefined) out.width = width;
  const height = clampInt(value.height, 200, 8192);
  if (height !== undefined) out.height = height;
  if (isRdpColorDepth(value.colorDepth)) out.colorDepth = value.colorDepth;
  const audioEnabled = readBoolean(value.audioEnabled);
  if (audioEnabled !== undefined) out.audioEnabled = audioEnabled;
  const clipboardSync = readBoolean(value.clipboardSync);
  if (clipboardSync !== undefined) out.clipboardSync = clipboardSync;
  const clipboardFilesEnabled = readBoolean(value.clipboardFilesEnabled);
  if (clipboardFilesEnabled !== undefined) out.clipboardFilesEnabled = clipboardFilesEnabled;
  if (isRdpSecurityMode(value.securityMode)) out.securityMode = value.securityMode;
  const ignoreCertErrors = readBoolean(value.ignoreCertErrors);
  if (ignoreCertErrors !== undefined) out.ignoreCertErrors = ignoreCertErrors;
  const loadBalanceInfo = readTrimmedString(value.loadBalanceInfo);
  if (loadBalanceInfo !== undefined) out.loadBalanceInfo = loadBalanceInfo;
  const alternateShell = readTrimmedString(value.alternateShell);
  if (alternateShell !== undefined) out.alternateShell = alternateShell;
  const shellWorkingDir = readTrimmedString(value.shellWorkingDir);
  if (shellWorkingDir !== undefined) out.shellWorkingDir = shellWorkingDir;
  const remoteApplicationMode = readBoolean(value.remoteApplicationMode);
  if (remoteApplicationMode !== undefined) out.remoteApplicationMode = remoteApplicationMode;
  const remoteApplicationProgram = readTrimmedString(value.remoteApplicationProgram);
  if (remoteApplicationProgram !== undefined) out.remoteApplicationProgram = remoteApplicationProgram;

  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Strictly allowlist non-sensitive `VncConfig` fields.
 * Never retains plaintext `password` or unknown properties.
 */
export const sanitizeVncConfig = (value: unknown): VncConfig | undefined => {
  if (!isRecord(value)) return undefined;

  const out: VncConfig = {};
  const enabled = readBoolean(value.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const defaultConnect = readBoolean(value.defaultConnect);
  if (defaultConnect !== undefined) out.defaultConnect = defaultConnect;
  if (isValidPort(value.port)) out.port = value.port;
  const identityId = readTrimmedString(value.identityId);
  if (identityId !== undefined) out.identityId = identityId;
  const username = readTrimmedString(value.username);
  if (username !== undefined) out.username = username;
  const useHostCredentials = readBoolean(value.useHostCredentials);
  if (useHostCredentials !== undefined) out.useHostCredentials = useHostCredentials;
  const tunnelViaHostSsh = readBoolean(value.tunnelViaHostSsh);
  if (tunnelViaHostSsh !== undefined) out.tunnelViaHostSsh = tunnelViaHostSsh;
  const tunnelTargetHost = readTrimmedString(value.tunnelTargetHost);
  if (tunnelTargetHost !== undefined) out.tunnelTargetHost = tunnelTargetHost;
  if (isVncScalingMode(value.scalingMode)) out.scalingMode = value.scalingMode;
  const quality = clampInt(value.quality, 0, 9);
  if (quality !== undefined) out.quality = quality;
  const compressionLevel = clampInt(value.compressionLevel, 0, 9);
  if (compressionLevel !== undefined) out.compressionLevel = compressionLevel;
  const viewOnly = readBoolean(value.viewOnly);
  if (viewOnly !== undefined) out.viewOnly = viewOnly;
  const sharedSession = readBoolean(value.sharedSession);
  if (sharedSession !== undefined) out.sharedSession = sharedSession;
  const clipboardSync = readBoolean(value.clipboardSync);
  if (clipboardSync !== undefined) out.clipboardSync = clipboardSync;
  const showRemoteCursor = readBoolean(value.showRemoteCursor);
  if (showRemoteCursor !== undefined) out.showRemoteCursor = showRemoteCursor;

  return Object.keys(out).length > 0 ? out : undefined;
};

export const normalizeRdpConfig = (
  config?: Partial<RdpConfig> | null,
): NormalizedRdpConfig => ({
  ...DEFAULT_RDP_CONFIG,
  ...(sanitizeRdpConfig(config) ?? {}),
});

export const normalizeVncConfig = (
  config?: Partial<VncConfig> | null,
): NormalizedVncConfig => ({
  ...DEFAULT_VNC_CONFIG,
  ...(sanitizeVncConfig(config) ?? {}),
});

export interface StandaloneRemoteDesktopHostInput {
  id?: string;
  label?: string;
  hostname: string;
  port?: number;
  username?: string;
  password?: string;
  savePassword?: boolean;
  identityId?: string;
  group?: string;
  tags?: string[];
  os?: Host['os'];
  notes?: string;
  ephemeral?: boolean;
  createdAt?: number;
  hostChain?: HostChainConfig;
  proxyProfileId?: string;
  proxyConfig?: ProxyConfig;
  directProxy?: boolean;
  rdpConfig?: RdpConfig;
  vncConfig?: VncConfig;
}

/**
 * Build a standalone RDP or VNC Host record with iOS sync invariants guaranteed:
 * - `username` is always a string (`""` when omitted, never `undefined`)
 * - `os` defaults to `'windows'` for RDP and `'linux'` for VNC
 * - `port` defaults to `3389` (RDP) / `5900` (VNC)
 * - `tags` is always an array (`[]` by default)
 * - `authMethod: 'password'` + `authPolicyVersion: 1` when inline password is set
 * - `rdpConfig` / `vncConfig` never contain passwords
 */
export const buildStandaloneRemoteDesktopHost = (
  protocol: RemoteDesktopProtocol,
  input: StandaloneRemoteDesktopHostInput,
): Host => {
  const defaultPort = protocol === 'rdp' ? DEFAULT_RDP_PORT : DEFAULT_VNC_PORT;
  const sanitizedRdp = protocol === 'rdp' ? sanitizeRdpConfig(input.rdpConfig) : undefined;
  const sanitizedVnc = protocol === 'vnc' ? sanitizeVncConfig(input.vncConfig) : undefined;
  const resolvedPort =
    (isValidPort(input.port) ? input.port : undefined)
    ?? (protocol === 'rdp' ? sanitizedRdp?.port : sanitizedVnc?.port)
    ?? defaultPort;
  const hostname = input.hostname.trim();
  const label = input.label?.trim() || hostname;
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const identityId = input.identityId?.trim() || undefined;
  const hasInlinePassword = !identityId && typeof input.password === 'string' && input.password.length > 0;
  const effectivePassword = hasInlinePassword && (input.savePassword !== false || input.ephemeral === true)
    ? input.password
    : undefined;
  const os: Host['os'] = input.os ?? (protocol === 'rdp' ? 'windows' : 'linux');

  return {
    id: input.id ?? crypto.randomUUID(),
    label,
    hostname,
    port: resolvedPort,
    username,
    ...(identityId ? { identityId } : {}),
    ...(effectivePassword !== undefined ? { password: effectivePassword } : {}),
    ...(input.savePassword !== undefined ? { savePassword: input.savePassword } : {}),
    ...(effectivePassword !== undefined || identityId
      ? { authMethod: 'password' as const, authPolicyVersion: 1 as const }
      : {}),
    group: input.group?.trim() ?? '',
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    os,
    osOverride: input.os ?? (protocol === 'rdp' ? 'windows' : 'auto'),
    protocol,
    sshInputCompatibility: false,
    moshEnabled: false,
    etEnabled: false,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    ...(input.hostChain ? { hostChain: input.hostChain } : {}),
    ...(input.proxyProfileId ? { proxyProfileId: input.proxyProfileId } : {}),
    ...(input.proxyConfig ? { proxyConfig: input.proxyConfig } : {}),
    ...(input.directProxy !== undefined ? { directProxy: input.directProxy } : {}),
    ...(protocol === 'rdp'
      ? { rdpConfig: { ...(sanitizedRdp ?? {}), port: resolvedPort } }
      : { vncConfig: { ...(sanitizedVnc ?? {}), port: resolvedPort } }),
  };
};

export const buildStandaloneRdpHost = (
  input: Omit<StandaloneRemoteDesktopHostInput, 'vncConfig'>,
): Host => buildStandaloneRemoteDesktopHost('rdp', input);

export const buildStandaloneVncHost = (
  input: Omit<StandaloneRemoteDesktopHostInput, 'rdpConfig'>,
): Host => buildStandaloneRemoteDesktopHost('vnc', input);

export interface RemoteDesktopConnectionSpec {
  protocol: RemoteDesktopProtocol;
  isCompanion: boolean;
  label: string;
  /** Target host to connect to (127.0.0.1 or tunnelTargetHost when tunneled via companion SSH). */
  hostname: string;
  /** Original vault host hostname (used for SSH tunnel outer leg and display). */
  hostHostname: string;
  port: number;
  username: string;
  domain: string;
  password?: string;
  identityId?: string;
  credentialSource: 'identity' | 'host' | 'prompt';
  needsPasswordPrompt: boolean;
  tunnelViaHostSsh: boolean;
  tunnelTargetHost: string;
  hostChain?: HostChainConfig;
  proxyProfileId?: string;
  proxyConfig?: ProxyConfig;
  directProxy?: boolean;
  rdpConfig?: NormalizedRdpConfig;
  vncConfig?: NormalizedVncConfig;
}

const findIdentity = (
  identities: readonly Identity[] | undefined,
  id: string | undefined,
): Identity | undefined => {
  if (!id || !identities?.length) return undefined;
  return identities.find((item) => item.id === id);
};

export const resolveRemoteDesktopConnectionSpec = (
  host: Host,
  protocol: RemoteDesktopProtocol,
  identities: readonly Identity[] = [],
): RemoteDesktopConnectionSpec => {
  const isCompanion = host.protocol !== protocol;
  const rdpConfig = protocol === 'rdp' ? normalizeRdpConfig(host.rdpConfig) : undefined;
  const vncConfig = protocol === 'vnc' ? normalizeVncConfig(host.vncConfig) : undefined;
  const activeConfig = protocol === 'rdp' ? rdpConfig! : vncConfig!;

  const port = isCompanion
    ? activeConfig.port
    : (
        (protocol === 'rdp' ? host.rdpConfig?.port : host.vncConfig?.port)
        ?? (isValidPort(host.port) ? host.port : undefined)
        ?? activeConfig.port
      );

  // Companion desktop sessions default to tunneling over the host's SSH connection
  // unless explicitly opted out (`tunnelViaHostSsh === false`).
  const tunnelViaHostSsh = isCompanion && activeConfig.tunnelViaHostSsh !== false;
  const tunnelTargetHost = activeConfig.tunnelTargetHost?.trim() || '127.0.0.1';
  const hostHostname = host.hostname.trim();
  const targetHostname = tunnelViaHostSsh ? tunnelTargetHost : hostHostname;

  let rawUsername = '';
  let explicitDomain = protocol === 'rdp' ? (rdpConfig?.domain ?? '') : '';
  let password: string | undefined;
  let resolvedIdentityId: string | undefined;
  let credentialSource: 'identity' | 'host' | 'prompt' = 'prompt';

  if (!isCompanion) {
    // Standalone VNC/RDP host: prefer identity (host.identityId or config.identityId),
    // otherwise use top-level host.username + host.password.
    const identityRef = host.identityId || activeConfig.identityId;
    const identity = findIdentity(identities, identityRef);
    if (identity) {
      resolvedIdentityId = identity.id;
      rawUsername = identity.username ?? '';
      if (protocol === 'rdp' && !explicitDomain && identity.domain) {
        explicitDomain = identity.domain;
      }
      password = identity.authMethod === 'password' ? identity.password : undefined;
      credentialSource = 'identity';
    } else {
      rawUsername = host.username || activeConfig.username || '';
      password = host.password;
      credentialSource = password ? 'host' : 'prompt';
    }
  } else {
    // Companion VNC/RDP on an SSH/other host: NEVER reads a password from rdpConfig/vncConfig.
    const companionIdentity = findIdentity(identities, activeConfig.identityId);
    if (companionIdentity) {
      resolvedIdentityId = companionIdentity.id;
      rawUsername = companionIdentity.username ?? '';
      if (protocol === 'rdp' && !explicitDomain && companionIdentity.domain) {
        explicitDomain = companionIdentity.domain;
      }
      password = companionIdentity.authMethod === 'password' ? companionIdentity.password : undefined;
      credentialSource = 'identity';
    } else if (activeConfig.useHostCredentials === true) {
      const hostIdentity = findIdentity(identities, host.identityId);
      if (hostIdentity) {
        resolvedIdentityId = hostIdentity.id;
        rawUsername = activeConfig.username || hostIdentity.username || '';
        if (protocol === 'rdp' && !explicitDomain && hostIdentity.domain) {
          explicitDomain = hostIdentity.domain;
        }
        password = hostIdentity.authMethod === 'password' ? hostIdentity.password : undefined;
        credentialSource = 'identity';
      } else {
        rawUsername = activeConfig.username || host.username || '';
        password = host.password;
        credentialSource = password ? 'host' : 'prompt';
      }
    } else {
      rawUsername = activeConfig.username ?? '';
      password = undefined;
      credentialSource = 'prompt';
    }
  }

  const { username, domain } = protocol === 'rdp'
    ? splitWindowsUserDomain(rawUsername, explicitDomain)
    : { username: rawUsername.trim(), domain: '' };

  const needsPasswordPrompt = !(typeof password === 'string' && password.length > 0);

  return {
    protocol,
    isCompanion,
    label: host.label?.trim() || hostHostname,
    hostname: targetHostname,
    hostHostname,
    port,
    username,
    domain,
    password,
    ...(resolvedIdentityId ? { identityId: resolvedIdentityId } : {}),
    credentialSource,
    needsPasswordPrompt,
    tunnelViaHostSsh,
    tunnelTargetHost,
    ...(host.hostChain ? { hostChain: host.hostChain } : {}),
    ...(host.proxyProfileId ? { proxyProfileId: host.proxyProfileId } : {}),
    ...(host.proxyConfig ? { proxyConfig: host.proxyConfig } : {}),
    ...(host.directProxy !== undefined ? { directProxy: host.directProxy } : {}),
    ...(protocol === 'rdp'
      ? { rdpConfig: { ...rdpConfig!, port, ...(domain ? { domain } : {}) } }
      : { vncConfig: { ...vncConfig!, port } }),
  };
};
