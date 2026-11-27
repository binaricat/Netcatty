import type {
  Host,
  RdpColorDepth,
  RdpConfig,
  RdpResolutionMode,
  RdpSecurityMode,
} from './models/connection';
import {
  buildStandaloneRdpHost,
  DEFAULT_RDP_PORT,
  splitWindowsUserDomain,
} from './remoteDesktop';

export interface ParsedRdpFile {
  hostname: string;
  port: number;
  alternateHostname?: string;
  alternatePort?: number;
  username: string;
  rawUsername?: string;
  domain?: string;
  loadBalanceInfo?: string;
  pcb?: string;
  alternateShell?: string;
  shellWorkingDir?: string;
  remoteApplicationMode?: boolean;
  remoteApplicationProgram?: string;
  width?: number;
  height?: number;
  colorDepth?: RdpColorDepth;
  smartSizing?: boolean;
  dynamicResolution?: boolean;
  resolutionMode?: RdpResolutionMode;
  clipboardSync?: boolean;
  audioEnabled?: boolean;
  gatewayHostname?: string;
  useRedirectionServerName?: boolean;
  enableCredSspSupport?: boolean;
  authenticationLevel?: number;
  securityMode?: RdpSecurityMode;
  ignoreCertErrors?: boolean;
  hasSignature: boolean;
  rawProperties: Record<string, string>;
}

export interface RdpFileToHostDraftOptions {
  id?: string;
  now?: number;
  group?: string;
  tags?: string[];
  notes?: string;
  ephemeral?: boolean;
  password?: string;
  savePassword?: boolean;
}

export interface GenerateRdpFileSpec {
  hostname: string;
  port?: number;
  username?: string;
  domain?: string;
  width?: number;
  height?: number;
  colorDepth?: RdpColorDepth;
  resolutionMode?: RdpResolutionMode;
  audioEnabled?: boolean;
  clipboardSync?: boolean;
  securityMode?: RdpSecurityMode;
  ignoreCertErrors?: boolean;
  loadBalanceInfo?: string;
  alternateShell?: string;
  shellWorkingDir?: string;
  remoteApplicationMode?: boolean;
  remoteApplicationProgram?: string;
}

const IGNORED_SIGNATURE_KEYS = new Set(['signscope', 'signature']);

const stripUtf8Bom = (text: string): string => (
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
);

const decodeBytesAsRdpText = (bytes: Uint8Array): string => {
  if (bytes.length >= 2) {
    // UTF-16LE BOM: FF FE
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    // UTF-16BE BOM: FE FF
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  // Heuristic UTF-16LE without BOM: ASCII bytes interleaved with 0x00 in odd positions.
  if (bytes.length >= 4 && bytes.length % 2 === 0 && bytes[0] !== 0 && bytes[1] === 0) {
    let nulOddCount = 0;
    const samplePairs = Math.min(32, bytes.length / 2);
    for (let i = 0; i < samplePairs; i += 1) {
      if (bytes[i * 2 + 1] === 0) nulOddCount += 1;
    }
    if (nulOddCount >= Math.ceil(samplePairs * 0.75)) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
  }
  return stripUtf8Bom(new TextDecoder('utf-8').decode(bytes));
};

/**
 * Decode UTF-8 (with or without BOM) or UTF-16LE/BE `.rdp` content into plain text.
 * Also recovers UTF-16LE strings accidentally decoded as latin1/binary.
 */
export const decodeRdpFileText = (
  content: string | Uint8Array | ArrayBuffer,
): string => {
  if (content instanceof ArrayBuffer) {
    return decodeBytesAsRdpText(new Uint8Array(content));
  }
  if (content instanceof Uint8Array) {
    return decodeBytesAsRdpText(content);
  }
  if (typeof content !== 'string') return '';

  // Detect raw UTF-16LE BOM read into a latin1 string: "\u00ff\u00fe..."
  if (content.length >= 2 && content.charCodeAt(0) === 0xff && content.charCodeAt(1) === 0xfe) {
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i += 1) {
      bytes[i] = content.charCodeAt(i) & 0xff;
    }
    return decodeBytesAsRdpText(bytes);
  }
  // Detect BOM-less UTF-16LE read as latin1 (contains NUL bytes at odd indices)
  if (content.includes('\u0000')) {
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i += 1) {
      bytes[i] = content.charCodeAt(i) & 0xff;
    }
    return decodeBytesAsRdpText(bytes);
  }

  return stripUtf8Bom(content);
};

const parseRdpInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = /^0x[0-9a-f]+$/i.test(trimmed)
    ? Number.parseInt(trimmed, 16)
    : /^-?\d+$/.test(trimmed)
      ? Number.parseInt(trimmed, 10)
      : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseValidPort = (raw: number | string | undefined): number | undefined => {
  const num = typeof raw === 'number' ? raw : parseRdpInt(raw);
  if (num === undefined || !Number.isInteger(num) || num < 1 || num > 65535) {
    return undefined;
  }
  return num;
};

const parseRdpAddress = (
  raw: string | undefined,
): { hostname: string; port?: number } | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Bracketed IPv6: [2001:db8::1]:3389 or [2001:db8::1]
  if (trimmed.startsWith('[')) {
    const endBracket = trimmed.indexOf(']');
    if (endBracket === -1) return null;
    const hostname = trimmed.slice(1, endBracket).trim();
    if (!hostname) return null;
    const rest = trimmed.slice(endBracket + 1).trim();
    if (!rest) return { hostname };
    if (rest.startsWith(':')) {
      const port = parseValidPort(rest.slice(1));
      if (port === undefined) return null;
      return { hostname, port };
    }
    return null;
  }

  // Bare IPv6 (multiple colons, no brackets)
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    return { hostname: trimmed };
  }

  // host:port
  if (colonCount === 1) {
    const colonIdx = trimmed.indexOf(':');
    const hostname = trimmed.slice(0, colonIdx).trim();
    const portStr = trimmed.slice(colonIdx + 1).trim();
    if (!hostname) return null;
    if (!portStr) return { hostname };
    const port = parseValidPort(portStr);
    if (port === undefined) return null;
    return { hostname, port };
  }

  return { hostname: trimmed };
};

const parseColorDepth = (raw: number | undefined): RdpColorDepth | undefined => {
  if (raw === 16 || raw === 24 || raw === 32) return raw;
  if (raw === 15) return 16;
  return undefined;
};

const parseRdpBoolInt = (raw: number | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  if (raw === 0) return false;
  if (raw === 1) return true;
  return undefined;
};

export const parseRdpFile = (
  content: string | Uint8Array | ArrayBuffer,
): ParsedRdpFile => {
  const text = decodeRdpFileText(content);
  const lines = text.split(/\r\n|\n|\r/);
  const rawProperties: Record<string, string> = {};
  let hasSignature = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const match = trimmed.match(/^([^:]+):([sibSIB]):(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[3];
    if (!key) continue;
    if (IGNORED_SIGNATURE_KEYS.has(key)) {
      hasSignature = true;
      continue;
    }
    rawProperties[key] = value;
  }

  const fullAddress = parseRdpAddress(rawProperties['full address']);
  const altAddress = parseRdpAddress(rawProperties['alternate full address']);
  const serverPort = parseValidPort(rawProperties['server port']);

  const hostname = fullAddress?.hostname ?? altAddress?.hostname ?? '';
  const port = fullAddress?.port ?? altAddress?.port ?? serverPort ?? DEFAULT_RDP_PORT;

  const rawUsername = rawProperties['username']?.trim() || undefined;
  const rawDomain = rawProperties['domain']?.trim() || undefined;
  const { username, domain } = splitWindowsUserDomain(rawUsername, rawDomain);

  const loadBalanceInfo = rawProperties['loadbalanceinfo']?.trim() || undefined;
  const pcb = rawProperties['pcb']?.trim() || undefined;
  const alternateShell = rawProperties['alternate shell']?.trim() || undefined;
  const shellWorkingDir = rawProperties['shell working directory']?.trim() || undefined;
  const remoteApplicationMode = parseRdpBoolInt(parseRdpInt(rawProperties['remoteapplicationmode']));
  const remoteApplicationProgram = rawProperties['remoteapplicationprogram']?.trim() || undefined;

  const parsedWidth = parseRdpInt(rawProperties['desktopwidth']);
  const parsedHeight = parseRdpInt(rawProperties['desktopheight']);
  const width = parsedWidth !== undefined && parsedWidth >= 200 && parsedWidth <= 8192 ? parsedWidth : undefined;
  const height = parsedHeight !== undefined && parsedHeight >= 200 && parsedHeight <= 8192 ? parsedHeight : undefined;
  const colorDepth = parseColorDepth(parseRdpInt(rawProperties['session bpp']));

  const smartSizing = parseRdpBoolInt(parseRdpInt(rawProperties['smart sizing']));
  const dynamicResolution = parseRdpBoolInt(parseRdpInt(rawProperties['dynamic resolution']));
  let resolutionMode: RdpResolutionMode | undefined;
  if (dynamicResolution === true) {
    resolutionMode = 'dynamic';
  } else if (smartSizing === true) {
    resolutionMode = 'fit';
  } else if (width !== undefined && height !== undefined) {
    resolutionMode = 'fixed';
  }

  const clipboardSync = parseRdpBoolInt(parseRdpInt(rawProperties['redirectclipboard']));
  const audioMode = parseRdpInt(rawProperties['audiomode']);
  const audioEnabled = audioMode === undefined ? undefined : audioMode === 0;

  const gatewayHostname = rawProperties['gatewayhostname']?.trim() || undefined;
  const useRedirectionServerName = parseRdpBoolInt(parseRdpInt(rawProperties['use redirection server name']));
  const enableCredSspSupport = parseRdpBoolInt(parseRdpInt(rawProperties['enablecredsspsupport']));
  const authenticationLevel = parseRdpInt(rawProperties['authentication level']);

  const securityMode: RdpSecurityMode | undefined =
    enableCredSspSupport === false
      ? 'tls'
      : enableCredSspSupport === true
        ? 'auto'
        : undefined;
  const ignoreCertErrors =
    authenticationLevel === undefined
      ? undefined
      : authenticationLevel === 0;

  return {
    hostname,
    port,
    ...(altAddress ? { alternateHostname: altAddress.hostname } : {}),
    ...(altAddress?.port !== undefined ? { alternatePort: altAddress.port } : {}),
    username,
    ...(rawUsername ? { rawUsername } : {}),
    ...(domain ? { domain } : {}),
    ...(loadBalanceInfo ? { loadBalanceInfo } : {}),
    ...(pcb ? { pcb } : {}),
    ...(alternateShell ? { alternateShell } : {}),
    ...(shellWorkingDir ? { shellWorkingDir } : {}),
    ...(remoteApplicationMode !== undefined ? { remoteApplicationMode } : {}),
    ...(remoteApplicationProgram ? { remoteApplicationProgram } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(colorDepth !== undefined ? { colorDepth } : {}),
    ...(smartSizing !== undefined ? { smartSizing } : {}),
    ...(dynamicResolution !== undefined ? { dynamicResolution } : {}),
    ...(resolutionMode !== undefined ? { resolutionMode } : {}),
    ...(clipboardSync !== undefined ? { clipboardSync } : {}),
    ...(audioEnabled !== undefined ? { audioEnabled } : {}),
    ...(gatewayHostname ? { gatewayHostname } : {}),
    ...(useRedirectionServerName !== undefined ? { useRedirectionServerName } : {}),
    ...(enableCredSspSupport !== undefined ? { enableCredSspSupport } : {}),
    ...(authenticationLevel !== undefined ? { authenticationLevel } : {}),
    ...(securityMode !== undefined ? { securityMode } : {}),
    ...(ignoreCertErrors !== undefined ? { ignoreCertErrors } : {}),
    hasSignature,
    rawProperties,
  };
};

export const parsedRdpFileToRdpConfig = (parsed: ParsedRdpFile): RdpConfig => ({
  port: parsed.port,
  ...(parsed.domain ? { domain: parsed.domain } : {}),
  ...(parsed.resolutionMode ? { resolutionMode: parsed.resolutionMode } : {}),
  ...(parsed.width !== undefined ? { width: parsed.width } : {}),
  ...(parsed.height !== undefined ? { height: parsed.height } : {}),
  ...(parsed.colorDepth !== undefined ? { colorDepth: parsed.colorDepth } : {}),
  ...(parsed.audioEnabled !== undefined ? { audioEnabled: parsed.audioEnabled } : {}),
  ...(parsed.clipboardSync !== undefined ? { clipboardSync: parsed.clipboardSync } : {}),
  ...(parsed.securityMode !== undefined ? { securityMode: parsed.securityMode } : {}),
  ...(parsed.ignoreCertErrors !== undefined ? { ignoreCertErrors: parsed.ignoreCertErrors } : {}),
  ...(parsed.loadBalanceInfo ? { loadBalanceInfo: parsed.loadBalanceInfo } : {}),
  ...(parsed.alternateShell ? { alternateShell: parsed.alternateShell } : {}),
  ...(parsed.shellWorkingDir ? { shellWorkingDir: parsed.shellWorkingDir } : {}),
  ...(parsed.remoteApplicationMode !== undefined
    ? { remoteApplicationMode: parsed.remoteApplicationMode }
    : {}),
  ...(parsed.remoteApplicationProgram
    ? { remoteApplicationProgram: parsed.remoteApplicationProgram }
    : {}),
});

export const rdpFileToHostDraft = (
  parsed: ParsedRdpFile,
  fallbackName?: string,
  options?: RdpFileToHostDraftOptions,
): Host => {
  const cleanedName = fallbackName?.replace(/\.rdp$/i, '').trim();
  const label = cleanedName || parsed.hostname || 'RDP Host';
  return buildStandaloneRdpHost({
    id: options?.id,
    label,
    hostname: parsed.hostname,
    port: parsed.port,
    username: parsed.username,
    password: options?.password,
    savePassword: options?.savePassword,
    group: options?.group,
    tags: options?.tags,
    notes: options?.notes,
    ephemeral: options?.ephemeral,
    createdAt: options?.now,
    os: 'windows',
    rdpConfig: parsedRdpFileToRdpConfig(parsed),
  });
};

const sanitizeRdpLineValue = (value: string): string => (
  value.replace(/[\r\n\0]/g, '').trim()
);

const formatRdpFullAddress = (hostname: string, port: number): string => {
  const cleanHost = sanitizeRdpLineValue(hostname);
  const hostPart = cleanHost.includes(':') && !cleanHost.startsWith('[')
    ? `[${cleanHost}]`
    : cleanHost;
  return port === DEFAULT_RDP_PORT ? hostPart : `${hostPart}:${port}`;
};

/**
 * Generate a standard CRLF-delimited Microsoft `.rdp` file for System RDP Client launch.
 * Never embeds plaintext passwords.
 */
export const generateRdpFileContent = (spec: GenerateRdpFileSpec): string => {
  const port = parseValidPort(spec.port) ?? DEFAULT_RDP_PORT;
  const lines: string[] = [
    `full address:s:${formatRdpFullAddress(spec.hostname, port)}`,
    `server port:i:${port}`,
    'prompt for credentials:i:1',
    'screen mode id:i:2',
  ];

  const { username, domain } = splitWindowsUserDomain(spec.username, spec.domain);
  if (username) {
    const formattedUser = domain ? `${sanitizeRdpLineValue(domain)}\\${sanitizeRdpLineValue(username)}` : sanitizeRdpLineValue(username);
    lines.push(`username:s:${formattedUser}`);
  }
  if (domain) {
    lines.push(`domain:s:${sanitizeRdpLineValue(domain)}`);
  }

  if (spec.width !== undefined && Number.isInteger(spec.width) && spec.width >= 200) {
    lines.push(`desktopwidth:i:${spec.width}`);
  }
  if (spec.height !== undefined && Number.isInteger(spec.height) && spec.height >= 200) {
    lines.push(`desktopheight:i:${spec.height}`);
  }
  if (spec.colorDepth === 16 || spec.colorDepth === 24 || spec.colorDepth === 32) {
    lines.push(`session bpp:i:${spec.colorDepth}`);
  }

  if (spec.resolutionMode === 'dynamic') {
    lines.push('dynamic resolution:i:1');
    lines.push('smart sizing:i:0');
  } else if (spec.resolutionMode === 'fit') {
    lines.push('dynamic resolution:i:0');
    lines.push('smart sizing:i:1');
  } else if (spec.resolutionMode === 'fixed') {
    lines.push('dynamic resolution:i:0');
    lines.push('smart sizing:i:0');
  }

  if (spec.clipboardSync !== undefined) {
    lines.push(`redirectclipboard:i:${spec.clipboardSync ? 1 : 0}`);
  }
  if (spec.audioEnabled !== undefined) {
    // 0 = play on this computer, 2 = do not play
    lines.push(`audiomode:i:${spec.audioEnabled ? 0 : 2}`);
  }
  if (spec.securityMode !== undefined) {
    lines.push(`enablecredsspsupport:i:${spec.securityMode === 'tls' || spec.securityMode === 'rdp' ? 0 : 1}`);
  }
  if (spec.ignoreCertErrors !== undefined) {
    lines.push(`authentication level:i:${spec.ignoreCertErrors ? 0 : 2}`);
  }
  if (spec.loadBalanceInfo?.trim()) {
    lines.push(`loadbalanceinfo:s:${sanitizeRdpLineValue(spec.loadBalanceInfo)}`);
  }
  if (spec.alternateShell?.trim()) {
    lines.push(`alternate shell:s:${sanitizeRdpLineValue(spec.alternateShell)}`);
  }
  if (spec.shellWorkingDir?.trim()) {
    lines.push(`shell working directory:s:${sanitizeRdpLineValue(spec.shellWorkingDir)}`);
  }
  if (spec.remoteApplicationMode !== undefined) {
    lines.push(`remoteapplicationmode:i:${spec.remoteApplicationMode ? 1 : 0}`);
  }
  if (spec.remoteApplicationProgram?.trim()) {
    lines.push(`remoteapplicationprogram:s:${sanitizeRdpLineValue(spec.remoteApplicationProgram)}`);
  }

  return `${lines.join('\r\n')}\r\n`;
};
