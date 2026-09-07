import type { GroupConfig, Host, HostProtocol, Identity, ManagedSource, ProxyProfile } from './models';
import { sanitizeHost } from './host';
import type { HostOsSelection } from './models/connection';
import {
  findIntroducedVaultJumpGraphIssue,
  findVaultGroupConfigJumpReference,
} from './vaultJumpGraph';

const DEFAULT_SSH_PORT = 22;
const DEFAULT_TELNET_PORT = 23;
const UNSAFE_SSH_CONFIG_VALUE = /[\r\n\0]/;
const HOSTNAME_WHITESPACE = /\s/;
const UNSAFE_SSH_JUMP_HOSTNAME = /[\s,@#]/;
const UNSAFE_SSH_JUMP_USERNAME = /[\s,#]/;

const isSafeSshConfigValue = (value: string): boolean =>
  !UNSAFE_SSH_CONFIG_VALUE.test(value);

const isSafeSshJumpHostname = (value: string): boolean =>
  !value.startsWith('-') && !UNSAFE_SSH_JUMP_HOSTNAME.test(value);

const isSafeSshJumpUsername = (value: string): boolean =>
  !value.startsWith('-') && !UNSAFE_SSH_JUMP_USERNAME.test(value);

export type VaultHostDraftProtocol = Exclude<HostProtocol, 'mosh' | 'et' | 'serial'>;

export interface VaultHostDraft {
  label?: unknown;
  name?: unknown;
  hostname?: unknown;
  host?: unknown;
  ip?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  savePassword?: unknown;
  keyPath?: unknown;
  keypath?: unknown;
  passphrase?: unknown;
  group?: unknown;
  tags?: unknown;
  notes?: unknown;
  protocol?: unknown;
  os?: unknown;
}

export interface VaultHostUpdatePatch extends VaultHostDraft {
  identityId?: unknown;
  jumpHostIds?: unknown;
  proxyProfileId?: unknown;
  startupCommand?: unknown;
  startupCommandRunMode?: unknown;
  environmentVariables?: unknown;
  moshEnabled?: unknown;
  moshServerPath?: unknown;
  etEnabled?: unknown;
  etPort?: unknown;
  serialConfig?: unknown;
}

export interface VaultHostUpdateOptions {
  resolveEffectiveHost?: (host: Host) => Host;
  groupConfigs?: GroupConfig[];
  managedSources?: ManagedSource[];
  identities?: Identity[];
  proxyProfiles?: ProxyProfile[];
}

export interface VaultHostCreateIssue {
  index: number;
  error: string;
}

export interface VaultHostKeyPassphrase {
  hostId: string;
  keyPath: string;
  passphrase: string;
}

const normalizeGroupPath = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.replace(/\\/g, '/').split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts.join('/') : undefined;
};

const normalizeProtocol = (raw: unknown): VaultHostDraftProtocol | undefined => {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'ssh' || value === 'ssh2') return 'ssh';
  if (value === 'telnet') return 'telnet';
  if (value === 'local') return 'local';
  return undefined;
};

const normalizeOs = (raw: unknown): HostOsSelection | undefined => {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'auto' || value === 'freebsd' || value === 'unknown') return value;
  if (value === 'linux') return 'linux';
  if (value === 'windows' || value === 'win') return 'windows';
  if (value === 'macos' || value === 'mac' || value === 'osx' || value === 'darwin') return 'macos';
  return undefined;
};

const parsePort = (raw: unknown): number | undefined => {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
};

const defaultPortForProtocol = (protocol: HostProtocol | undefined): number =>
  protocol === 'telnet' ? DEFAULT_TELNET_PORT : DEFAULT_SSH_PORT;

const supportsSshJump = (host: Host): boolean =>
  host.protocol === undefined || host.protocol === 'ssh';

const parseBoolean = (raw: unknown): boolean | undefined => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
};

const normalizeTags = (values: unknown[]): string[] => Array.from(
  new Set(values.map((entry) => String(entry).trim()).filter(Boolean)),
);

const parseTags = (
  raw: unknown,
): { ok: true; tags: string[] } | { ok: false; error: string } => {
  if (raw === undefined || raw === null || raw === '') return { ok: true, tags: [] };
  if (Array.isArray(raw)) return { ok: true, tags: normalizeTags(raw) };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'tags must be an array or comma-separated string.' };
  }

  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, tags: [] };
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return { ok: false, error: 'tags JSON must be an array.' };
      }
      return { ok: true, tags: normalizeTags(parsed) };
    } catch {
      return { ok: false, error: 'tags must be a valid JSON array.' };
    }
  }

  return {
    ok: true,
    tags: normalizeTags(trimmed.split(/[,;，]/g)),
  };
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const firstProvided = (
  value: Record<string, unknown>,
  keys: string[],
): { provided: boolean; value?: unknown } => {
  for (const key of keys) {
    if (hasOwn(value, key)) return { provided: true, value: value[key] };
  }
  return { provided: false };
};

const parseKeyPath = (draft: VaultHostDraft): string | undefined => {
  const raw = draft.keyPath ?? draft.keypath;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

/** Endpoint-only identity (protocol/host/port/user). Used for managed ssh_config matching. */
export const buildVaultHostEndpointKey = (
  host: Pick<Host, 'hostname' | 'port' | 'username' | 'protocol'>,
): string =>
  `${(host.protocol ?? 'ssh').toLowerCase()}|${host.hostname.toLowerCase()}|${host.port}|${(host.username ?? '').toLowerCase()}`;

/**
 * Session identity for vault import/create dedupe.
 * Same endpoint in a different group is a distinct connection (e.g. direct vs proxy copy).
 */
export const buildVaultHostMergeKey = (
  host: Pick<Host, 'hostname' | 'port' | 'username' | 'protocol' | 'group'>,
): string => {
  // Keep normalized group spelling (do not case-fold). Vault group paths are
  // compared exactly elsewhere, so Prod vs prod are distinct sessions.
  const group = normalizeGroupPath(host.group) ?? '';
  return `${buildVaultHostEndpointKey(host)}|${group}`;
};

export function buildVaultHostFromDraft(
  draft: VaultHostDraft,
): { ok: true; host: Host } | { ok: false; error: string } {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, error: 'host must be an object.' };
  }
  const rawHostname = draft.hostname ?? draft.host ?? draft.ip;
  const hostname = typeof rawHostname === 'string' ? rawHostname.trim() : '';
  if (!hostname) {
    return { ok: false, error: 'hostname is required.' };
  }
  if (!isSafeSshConfigValue(hostname)) {
    return { ok: false, error: 'hostname must not contain line breaks or null bytes.' };
  }
  if (HOSTNAME_WHITESPACE.test(hostname)) {
    return { ok: false, error: 'hostname must not contain whitespace.' };
  }

  const parsedProtocol = normalizeProtocol(draft.protocol);
  const hasProtocolInput = draft.protocol !== undefined
    && draft.protocol !== null
    && !(typeof draft.protocol === 'string' && !draft.protocol.trim());
  if (hasProtocolInput && parsedProtocol === undefined) {
    return { ok: false, error: 'protocol must be ssh, telnet, or local.' };
  }
  const protocol = parsedProtocol ?? 'ssh';
  const parsedOs = normalizeOs(draft.os);
  const hasOsInput = draft.os !== undefined
    && draft.os !== null
    && !(typeof draft.os === 'string' && !draft.os.trim());
  if (hasOsInput && parsedOs === undefined) {
    return { ok: false, error: 'os must be auto, linux, windows, macos, freebsd, or unknown.' };
  }
  const os = parsedOs === 'windows' || parsedOs === 'macos' ? parsedOs : 'linux';
  const parsedPort = parsePort(draft.port);
  const hasPortInput = draft.port !== undefined
    && draft.port !== null
    && !(typeof draft.port === 'string' && !draft.port.trim());
  if (hasPortInput && parsedPort === undefined) {
    return { ok: false, error: 'port must be an integer between 1 and 65535.' };
  }
  const port = parsedPort ?? defaultPortForProtocol(protocol);
  const rawLabel = draft.label ?? draft.name;
  if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
    return { ok: false, error: 'label must be a string.' };
  }
  const label = typeof rawLabel === 'string' && rawLabel.trim()
    ? rawLabel.trim()
    : hostname;
  if (draft.username !== undefined && draft.username !== null && typeof draft.username !== 'string') {
    return { ok: false, error: 'username must be a string.' };
  }
  const username = typeof draft.username === 'string' ? draft.username.trim() : '';
  if (!isSafeSshConfigValue(label)) {
    return { ok: false, error: 'label must not contain line breaks or null bytes.' };
  }
  if (!isSafeSshConfigValue(username)) {
    return { ok: false, error: 'username must not contain line breaks or null bytes.' };
  }
  const savePasswordInput = firstProvided(draft as Record<string, unknown>, ['savePassword']);
  const savePassword = savePasswordInput.provided
    ? parseBoolean(savePasswordInput.value)
    : undefined;
  if (savePasswordInput.provided && savePassword === undefined) {
    return { ok: false, error: 'savePassword must be true or false.' };
  }
  if (draft.password !== undefined && draft.password !== null && typeof draft.password !== 'string') {
    return { ok: false, error: 'password must be a string.' };
  }
  const password = savePassword !== false && typeof draft.password === 'string' && draft.password
    ? draft.password
    : undefined;
  const rawKeyPath = draft.keyPath ?? draft.keypath;
  if (rawKeyPath !== undefined && rawKeyPath !== null && typeof rawKeyPath !== 'string') {
    return { ok: false, error: 'keyPath must be a string.' };
  }
  const keyPath = parseKeyPath(draft);
  if (keyPath && !isSafeSshConfigValue(keyPath)) {
    return { ok: false, error: 'keyPath must not contain line breaks or null bytes.' };
  }
  if (draft.passphrase !== undefined && draft.passphrase !== null && typeof draft.passphrase !== 'string') {
    return { ok: false, error: 'passphrase must be a string.' };
  }
  if (typeof draft.passphrase === 'string' && draft.passphrase && !keyPath) {
    return { ok: false, error: 'keyPath is required when passphrase is provided.' };
  }
  const tags = parseTags(draft.tags);
  if (!tags.ok) return tags;
  if (draft.group !== undefined && draft.group !== null && typeof draft.group !== 'string') {
    return { ok: false, error: 'group must be a string.' };
  }
  if (draft.notes !== undefined && draft.notes !== null && typeof draft.notes !== 'string') {
    return { ok: false, error: 'notes must be a string.' };
  }
  const notes = typeof draft.notes === 'string' && draft.notes.trim() ? draft.notes.trim() : undefined;
  const now = Date.now();

  return {
    ok: true,
    host: {
      id: crypto.randomUUID(),
      label,
      hostname,
      port,
      username,
      password,
      ...(savePassword !== undefined ? { savePassword } : {}),
      group: normalizeGroupPath(draft.group),
      tags: tags.tags,
      os,
      osOverride: parsedOs ?? 'auto',
      protocol,
      createdAt: now,
      ...(keyPath
        ? {
          identityFilePaths: [keyPath],
          authMethod: 'key' as const,
          authPolicyVersion: 1 as const,
          useSshAgent: false,
        }
        : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

export function applyVaultHostUpdate(
  existingHosts: Host[],
  existingGroups: string[],
  hostId: string,
  patch: VaultHostUpdatePatch,
  options: VaultHostUpdateOptions = {},
): {
  ok: true;
  hosts: Host[];
  customGroups: string[];
  updatedHost: Host;
} | { ok: false; error: string } {
  const hostIndex = existingHosts.findIndex((host) => host.id === hostId);
  if (hostIndex < 0) return { ok: false, error: `Host "${hostId}" was not found.` };

  const source = patch as Record<string, unknown>;
  const label = firstProvided(source, ['label', 'name']);
  const hostname = firstProvided(source, ['hostname', 'host', 'ip']);
  const port = firstProvided(source, ['port']);
  const username = firstProvided(source, ['username']);
  const password = firstProvided(source, ['password']);
  const savePassword = firstProvided(source, ['savePassword']);
  const keyPath = firstProvided(source, ['keyPath', 'keypath']);
  const group = firstProvided(source, ['group']);
  const tags = firstProvided(source, ['tags']);
  const notes = firstProvided(source, ['notes']);
  const protocol = firstProvided(source, ['protocol']);
  const os = firstProvided(source, ['os']);
  const identityId = firstProvided(source, ['identityId']);
  const jumpHostIds = firstProvided(source, ['jumpHostIds']);
  const proxyProfileId = firstProvided(source, ['proxyProfileId']);
  const startupCommand = firstProvided(source, ['startupCommand']);
  const startupCommandRunMode = firstProvided(source, ['startupCommandRunMode']);
  const environmentVariables = firstProvided(source, ['environmentVariables']);
  const moshEnabled = firstProvided(source, ['moshEnabled']);
  const moshServerPath = firstProvided(source, ['moshServerPath']);
  const etEnabled = firstProvided(source, ['etEnabled']);
  const etPort = firstProvided(source, ['etPort']);
  const serialConfig = firstProvided(source, ['serialConfig']);
  const provided = [label, hostname, port, username, password, savePassword, keyPath, group, tags, notes, protocol, os,
    identityId, jumpHostIds, proxyProfileId, startupCommand, startupCommandRunMode, environmentVariables,
    moshEnabled, moshServerPath, etEnabled, etPort, serialConfig]
    .some((entry) => entry.provided);
  if (!provided) return { ok: false, error: 'At least one host field is required.' };

  const current = existingHosts[hostIndex];
  let updated: Host = { ...current };

  if (label.provided) {
    if (typeof label.value !== 'string' || !label.value.trim()) {
      return { ok: false, error: 'label must not be empty.' };
    }
    if (!isSafeSshConfigValue(label.value)) {
      return { ok: false, error: 'label must not contain line breaks or null bytes.' };
    }
    updated.label = label.value.trim();
  }
  if (hostname.provided) {
    if (typeof hostname.value !== 'string' || !hostname.value.trim()) {
      return { ok: false, error: 'hostname must not be empty.' };
    }
    if (!isSafeSshConfigValue(hostname.value)) {
      return { ok: false, error: 'hostname must not contain line breaks or null bytes.' };
    }
    const requestedProtocol = protocol.provided
      ? String(protocol.value ?? '').trim().toLowerCase()
      : current.protocol;
    if (requestedProtocol !== 'serial' && HOSTNAME_WHITESPACE.test(hostname.value.trim())) {
      return { ok: false, error: 'hostname must not contain whitespace.' };
    }
    updated.hostname = hostname.value.trim();
  }
  if (port.provided) {
    const parsedPort = parsePort(port.value);
    if (parsedPort === undefined) {
      return { ok: false, error: 'port must be an integer between 1 and 65535.' };
    }
    updated.port = parsedPort;
  }
  if (group.provided) {
    if (typeof group.value !== 'string') {
      return { ok: false, error: 'group must be a string.' };
    }
    updated.group = normalizeGroupPath(group.value);
  }
  if (protocol.provided) {
    const rawProtocol = typeof protocol.value === 'string' ? protocol.value.trim().toLowerCase() : '';
    const nextProtocol = rawProtocol === 'serial' ? 'serial' : normalizeProtocol(protocol.value);
    if (!nextProtocol) {
      return { ok: false, error: 'protocol must be ssh, telnet, local, or serial.' };
    }
    if (current.protocol === 'serial' && nextProtocol !== 'serial' && !hostname.provided) {
      return { ok: false, error: 'hostname is required when changing a serial host to a network protocol.' };
    }
    if (
      nextProtocol !== 'serial'
      && !port.provided
      && (
        current.protocol === 'serial'
        || current.port === undefined
        || current.port === defaultPortForProtocol(current.protocol)
      )
    ) {
      updated.port = defaultPortForProtocol(nextProtocol);
    }
    updated.protocol = nextProtocol;
    if (nextProtocol !== 'ssh') {
      updated.moshEnabled = false;
      updated.etEnabled = false;
    }
  }

  if (os.provided) {
    const nextOs = normalizeOs(os.value);
    if (!nextOs) {
      return { ok: false, error: 'os must be auto, linux, windows, macos, freebsd, or unknown.' };
    }
    updated.osOverride = nextOs;
    updated.os = nextOs === 'windows' || nextOs === 'macos' ? nextOs : 'linux';
  }

  if (identityId.provided) {
    if (typeof identityId.value !== 'string') return { ok: false, error: 'identityId must be a string.' };
    const nextIdentityId = identityId.value.trim();
    const identity = options.identities?.find((item) => item.id === nextIdentityId);
    if (nextIdentityId && !identity) return { ok: false, error: `Identity "${nextIdentityId}" was not found.` };
    updated.identityId = nextIdentityId;
    if (identity) {
      updated.username = identity.username;
      updated.authMethod = identity.authMethod;
      updated.authPolicyVersion = 1;
      updated.password = undefined;
      updated.identityFileId = undefined;
      updated.identityFilePaths = undefined;
      updated.useSshAgent = false;
    } else if (current.identityId) {
      updated.authMethod = 'auto';
      updated.authPolicyVersion = 1;
      updated.identityFileId = undefined;
      updated.identityFilePaths = undefined;
      updated.useSshAgent = undefined;
    }
  }

  if (jumpHostIds.provided) {
    let ids: unknown = jumpHostIds.value;
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { return { ok: false, error: 'jumpHostIds must be a valid JSON array.' }; }
    }
    if (!Array.isArray(ids)) return { ok: false, error: 'jumpHostIds must be an array.' };
    const normalizedIds = ids.map(String).map((id) => id.trim()).filter(Boolean);
    if (new Set(normalizedIds).size !== normalizedIds.length) return { ok: false, error: 'jumpHostIds must not contain duplicates.' };
    if (normalizedIds.includes(hostId)) return { ok: false, error: 'A host cannot use itself as a jump host.' };
    const missing = normalizedIds.find((id) => !existingHosts.some((candidate) => candidate.id === id));
    if (missing) return { ok: false, error: `Jump host "${missing}" was not found.` };
    const unsupported = normalizedIds.find((id) => {
      const candidate = existingHosts.find((host) => host.id === id);
      if (!candidate) return false;
      const effectiveCandidate = options.resolveEffectiveHost?.(candidate) ?? candidate;
      return !supportsSshJump(effectiveCandidate);
    });
    if (unsupported) return { ok: false, error: `Jump host "${unsupported}" does not support SSH jump connections.` };
    updated.hostChain = { hostIds: normalizedIds };
  }
  if (proxyProfileId.provided) {
    if (typeof proxyProfileId.value !== 'string') return { ok: false, error: 'proxyProfileId must be a string.' };
    const nextProxyProfileId = proxyProfileId.value.trim();
    if (nextProxyProfileId && !options.proxyProfiles?.some((profile) => profile.id === nextProxyProfileId)) {
      return { ok: false, error: `Proxy profile "${nextProxyProfileId}" was not found.` };
    }
    updated.proxyProfileId = nextProxyProfileId;
    updated.proxyConfig = undefined;
  }
  if (startupCommand.provided) {
    if (typeof startupCommand.value !== 'string') return { ok: false, error: 'startupCommand must be a string.' };
    updated.startupCommand = startupCommand.value;
  }
  if (startupCommandRunMode.provided) {
    const mode = String(startupCommandRunMode.value ?? '');
    if (mode !== 'paste' && mode !== 'lineDelay' && mode !== '') return { ok: false, error: 'startupCommandRunMode must be paste or lineDelay.' };
    updated.startupCommandRunMode = mode === 'lineDelay' ? 'lineDelay' : undefined;
  }
  if (environmentVariables.provided) {
    let raw: unknown = environmentVariables.value;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return { ok: false, error: 'environmentVariables must be valid JSON.' }; }
    }
    if (Array.isArray(raw)) {
      const entries = raw.map((item) => item as Record<string, unknown>);
      if (entries.some((item) => typeof item?.name !== 'string')) return { ok: false, error: 'environmentVariables array entries require name and value.' };
      updated.environmentVariables = entries.map((item) => ({ name: String(item.name), value: String(item.value ?? '') }));
    } else if (raw && typeof raw === 'object') {
      updated.environmentVariables = Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value ?? '') }));
    } else return { ok: false, error: 'environmentVariables must be a JSON object or array.' };
  }
  const nextMoshEnabled = moshEnabled.provided ? parseBoolean(moshEnabled.value) : undefined;
  const nextEtEnabled = etEnabled.provided ? parseBoolean(etEnabled.value) : undefined;
  if (moshEnabled.provided && nextMoshEnabled === undefined) {
    return { ok: false, error: 'moshEnabled must be true or false.' };
  }
  if (etEnabled.provided && nextEtEnabled === undefined) {
    return { ok: false, error: 'etEnabled must be true or false.' };
  }
  if (nextMoshEnabled === true && nextEtEnabled === true) {
    return { ok: false, error: 'Mosh and ET cannot both be enabled.' };
  }
  if (moshEnabled.provided) {
    updated.moshEnabled = nextMoshEnabled;
    if (nextMoshEnabled) updated.etEnabled = false;
  }
  if (etEnabled.provided) {
    updated.etEnabled = nextEtEnabled;
    if (nextEtEnabled) updated.moshEnabled = false;
  }
  if (updated.protocol !== undefined && updated.protocol !== 'ssh' && (updated.moshEnabled || updated.etEnabled)) {
    return { ok: false, error: 'Mosh and ET require the SSH protocol.' };
  }
  if (moshServerPath.provided) updated.moshServerPath = String(moshServerPath.value ?? '') || undefined;
  if (etPort.provided) {
    const value = parsePort(etPort.value);
    if (value === undefined) return { ok: false, error: 'etPort must be an integer between 1 and 65535.' };
    updated.etPort = value;
  }
  if (serialConfig.provided) {
    let raw: unknown = serialConfig.value;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return { ok: false, error: 'serialConfig must be valid JSON.' }; }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'serialConfig must be a JSON object.' };
    const config = raw as Record<string, unknown>;
    const path = String(config.path ?? '').trim();
    const baudRate = Number(config.baudRate);
    if (!path || !Number.isInteger(baudRate) || baudRate <= 0) return { ok: false, error: 'serialConfig requires path and a positive baudRate.' };
    if (!isSafeSshConfigValue(path)) {
      return { ok: false, error: 'serialConfig.path must not contain line breaks or null bytes.' };
    }
    const dataBits = config.dataBits === undefined ? undefined : Number(config.dataBits);
    if (dataBits !== undefined && ![5, 6, 7, 8].includes(dataBits)) return { ok: false, error: 'serialConfig.dataBits must be 5, 6, 7, or 8.' };
    const stopBits = config.stopBits === undefined ? undefined : Number(config.stopBits);
    if (stopBits !== undefined && ![1, 1.5, 2].includes(stopBits)) return { ok: false, error: 'serialConfig.stopBits must be 1, 1.5, or 2.' };
    const parity = config.parity === undefined ? undefined : String(config.parity);
    if (parity !== undefined && !['none', 'even', 'odd', 'mark', 'space'].includes(parity)) return { ok: false, error: 'serialConfig.parity is invalid.' };
    const flowControl = config.flowControl === undefined ? undefined : String(config.flowControl);
    if (flowControl !== undefined && !['none', 'xon/xoff', 'rts/cts'].includes(flowControl)) return { ok: false, error: 'serialConfig.flowControl is invalid.' };
    const localEcho = config.localEcho === undefined ? undefined : parseBoolean(config.localEcho);
    if (config.localEcho !== undefined && localEcho === undefined) return { ok: false, error: 'serialConfig.localEcho must be true or false.' };
    const lineMode = config.lineMode === undefined ? undefined : parseBoolean(config.lineMode);
    if (config.lineMode !== undefined && lineMode === undefined) return { ok: false, error: 'serialConfig.lineMode must be true or false.' };
    const rawBackspaceBehavior = config.backspaceBehavior;
    const backspaceBehavior = rawBackspaceBehavior === undefined
      ? updated.serialConfig?.backspaceBehavior
      : String(rawBackspaceBehavior);
    if (backspaceBehavior !== undefined && !['default', 'ctrl-h'].includes(backspaceBehavior)) {
      return { ok: false, error: 'serialConfig.backspaceBehavior must be default or ctrl-h.' };
    }
    updated.serialConfig = {
      path,
      baudRate,
      ...(dataBits !== undefined ? { dataBits: dataBits as 5 | 6 | 7 | 8 } : {}),
      ...(stopBits !== undefined ? { stopBits: stopBits as 1 | 1.5 | 2 } : {}),
      ...(parity !== undefined ? { parity: parity as 'none' | 'even' | 'odd' | 'mark' | 'space' } : {}),
      ...(flowControl !== undefined ? { flowControl: flowControl as 'none' | 'xon/xoff' | 'rts/cts' } : {}),
      ...(localEcho !== undefined ? { localEcho } : {}),
      ...(lineMode !== undefined ? { lineMode } : {}),
      ...(backspaceBehavior !== undefined ? { backspaceBehavior: backspaceBehavior as 'default' | 'ctrl-h' } : {}),
    };
  }
  if (updated.protocol === 'serial' && updated.serialConfig) {
    if (serialConfig.provided && hostname.provided && updated.hostname !== updated.serialConfig.path) {
      return { ok: false, error: 'hostname and serialConfig.path must match for serial hosts.' };
    }
    if (hostname.provided && !serialConfig.provided) {
      updated.serialConfig = { ...updated.serialConfig, path: updated.hostname };
    } else {
      updated.hostname = updated.serialConfig.path;
    }
    updated.port = updated.serialConfig.baudRate;
  }
  if (
    protocol.provided
    && current.protocol !== 'serial'
    && updated.protocol === 'serial'
    && !updated.serialConfig
  ) {
    return { ok: false, error: 'serialConfig is required when protocol is serial.' };
  }

  const effectiveBeforeSavePassword = options.resolveEffectiveHost?.(updated) ?? updated;
  if (effectiveBeforeSavePassword.moshEnabled && effectiveBeforeSavePassword.etEnabled) {
    return { ok: false, error: 'Mosh and ET cannot both be enabled.' };
  }
  if (
    effectiveBeforeSavePassword.protocol !== undefined
    && effectiveBeforeSavePassword.protocol !== 'ssh'
    && (effectiveBeforeSavePassword.moshEnabled || effectiveBeforeSavePassword.etEnabled)
  ) {
    return { ok: false, error: 'Mosh and ET require the SSH protocol.' };
  }

  if (savePassword.provided) {
    const nextSavePassword = parseBoolean(savePassword.value);
    if (nextSavePassword === undefined) {
      return { ok: false, error: 'savePassword must be true or false.' };
    }
    updated.savePassword = nextSavePassword;
    if (!nextSavePassword) updated.password = undefined;
  }

  const effectiveCurrent = options.resolveEffectiveHost?.(updated) ?? updated;
  const selectedIdentityId = effectiveCurrent.identityId ?? effectiveBeforeSavePassword.identityId;
  const selectedIdentity = selectedIdentityId
    ? options.identities?.find((identity) => identity.id === selectedIdentityId)
    : undefined;

  if (username.provided) {
    if (typeof username.value !== 'string') {
      return { ok: false, error: 'username must be a string.' };
    }
    if (!isSafeSshConfigValue(username.value)) {
      return { ok: false, error: 'username must not contain line breaks or null bytes.' };
    }
    updated.username = username.value.trim();
    if (selectedIdentityId) {
      updated.identityId = '';
      if (selectedIdentity?.authMethod === 'password') {
        if (effectiveCurrent.savePassword !== false) {
          updated.password = selectedIdentity.password;
        }
        updated.authMethod = 'password';
        updated.authPolicyVersion = 1;
      } else if (selectedIdentity?.keyId) {
        updated.identityFileId = selectedIdentity.keyId;
        updated.authMethod = selectedIdentity.authMethod;
        updated.authPolicyVersion = 1;
        updated.useSshAgent = false;
      }
    }
  }
  if (savePassword.provided && updated.savePassword === false && !username.provided && selectedIdentity) {
    if (selectedIdentity.authMethod === 'password') {
      updated.identityId = '';
      updated.username = selectedIdentity.username;
      updated.authMethod = 'password';
      updated.authPolicyVersion = 1;
    } else {
      updated.identityId = selectedIdentity.id;
      updated.authMethod = selectedIdentity.authMethod;
      updated.authPolicyVersion = 1;
    }
  }
  if (password.provided) {
    if (typeof password.value !== 'string') {
      return { ok: false, error: 'password must be a string.' };
    }
    if (password.value && effectiveCurrent.savePassword === false) {
      return {
        ok: false,
        error: 'This host is configured not to save passwords. Enable password saving before updating it.',
      };
    }
    updated.password = password.value || undefined;
    if (!password.value) {
      updated.savePassword = false;
    }
    const keyPathIsEmpty = keyPath.provided
      && typeof keyPath.value === 'string'
      && !keyPath.value.trim();
    if (password.value && keyPathIsEmpty) {
      if (selectedIdentity && !username.provided) {
        updated.username = selectedIdentity.username;
      }
      updated.authMethod = 'password';
      updated.authPolicyVersion = 1;
      updated.identityId = '';
      updated.identityFileId = undefined;
      updated.identityFilePaths = undefined;
      updated.useSshAgent = false;
    } else if (selectedIdentityId) {
      if (selectedIdentity?.authMethod === 'password') {
        updated.identityId = '';
        updated.username = username.provided
          ? updated.username
          : selectedIdentity.username;
        updated.authMethod = 'password';
        updated.authPolicyVersion = 1;
      } else if (selectedIdentity && !username.provided) {
        updated.identityId = selectedIdentity.id;
        updated.authMethod = selectedIdentity.authMethod;
        updated.authPolicyVersion = 1;
      }
    }
  }
  if (keyPath.provided) {
    if (typeof keyPath.value !== 'string') {
      return { ok: false, error: 'keyPath must be a string.' };
    }
    const nextKeyPath = keyPath.value.trim();
    if (!isSafeSshConfigValue(nextKeyPath)) {
      return { ok: false, error: 'keyPath must not contain line breaks or null bytes.' };
    }
    updated.identityFilePaths = nextKeyPath ? [nextKeyPath] : [];
    if (nextKeyPath) {
      updated.identityFileId = undefined;
      updated.identityId = '';
      updated.authMethod = 'key';
      updated.authPolicyVersion = 1;
      updated.useSshAgent = false;
    } else if (
      !updated.identityId
      && !updated.identityFileId
      && !effectiveCurrent.identityId
      && !effectiveCurrent.identityFileId
      && updated.authMethod !== 'password'
      && effectiveCurrent.authMethod === 'key'
    ) {
      updated.authMethod = 'auto';
      updated.authPolicyVersion = 1;
      updated.useSshAgent = undefined;
    }
  }
  if (tags.provided) {
    const nextTags = parseTags(tags.value);
    if (!nextTags.ok) return nextTags;
    updated.tags = nextTags.tags;
  }
  if (notes.provided) {
    if (typeof notes.value !== 'string') {
      return { ok: false, error: 'notes must be a string.' };
    }
    updated.notes = notes.value.trim() || undefined;
  }
  if (options.managedSources) {
    const targetManagedSource = options.managedSources
      .filter((sourceInfo) => (
        updated.group === sourceInfo.groupName
        || updated.group?.startsWith(`${sourceInfo.groupName}/`)
      ))
      .sort((a, b) => b.groupName.length - a.groupName.length)[0];
    const canBeManaged = !updated.protocol || updated.protocol === 'ssh';
    if (targetManagedSource && canBeManaged) {
      for (const jumpHostId of updated.hostChain?.hostIds ?? []) {
        const jumpHost = existingHosts.find((candidate) => candidate.id === jumpHostId);
        if (!jumpHost) continue;
        if (!isSafeSshJumpHostname(jumpHost.hostname)) {
          return { ok: false, error: 'hostname contains characters that are unsafe for an SSH jump host.' };
        }
        if (jumpHost.username && !isSafeSshJumpUsername(jumpHost.username)) {
          return { ok: false, error: 'username contains characters that are unsafe for an SSH jump host.' };
        }
      }
      if (label.provided || current.managedSourceId !== targetManagedSource.id) {
        updated.label = updated.label.replace(/\s/g, '');
      }
      updated.managedSourceId = targetManagedSource.id;
    } else if (options.managedSources.length > 0 || !canBeManaged) {
      updated.managedSourceId = undefined;
    }

    const managedSourceIds = new Set(options.managedSources.map((sourceInfo) => sourceInfo.id));
    const isManagedJumpHost = existingHosts.some((candidate) => (
      candidate.id !== current.id
      && candidate.managedSourceId
      && managedSourceIds.has(candidate.managedSourceId)
      && (!candidate.protocol || candidate.protocol === 'ssh')
      && candidate.hostChain?.hostIds?.includes(current.id)
    ));
    if (isManagedJumpHost) {
      if (!isSafeSshJumpHostname(updated.hostname)) {
        return { ok: false, error: 'hostname contains characters that are unsafe for an SSH jump host.' };
      }
      if (updated.username && !isSafeSshJumpUsername(updated.username)) {
        return { ok: false, error: 'username contains characters that are unsafe for an SSH jump host.' };
      }
    }
  }

  updated = sanitizeHost(updated);
  if (updated.protocol === 'serial' && updated.serialConfig) {
    updated.hostname = updated.serialConfig.path;
  }
  const hosts = [...existingHosts];
  hosts[hostIndex] = updated;
  const jumpGraphIssue = findIntroducedVaultJumpGraphIssue(
    existingHosts,
    hosts,
    options.resolveEffectiveHost,
  );
  if (jumpGraphIssue) {
    if (jumpGraphIssue.kind === 'protocol' && jumpGraphIssue.jumpHostId === current.id) {
      return { ok: false, error: 'A host used as a jump host must keep an SSH connection type.' };
    }
    return { ok: false, error: jumpGraphIssue.error };
  }
  const groupConfigReference = findVaultGroupConfigJumpReference(
    options.groupConfigs ?? [],
    current.id,
  );
  if (groupConfigReference) {
    const effectiveBefore = options.resolveEffectiveHost?.(current) ?? current;
    const effectiveAfter = options.resolveEffectiveHost?.(updated) ?? updated;
    if (supportsSshJump(effectiveBefore) && !supportsSshJump(effectiveAfter)) {
      return { ok: false, error: 'A host used as a group jump host must keep an SSH connection type.' };
    }
  }
  const customGroups = updated.group
    ? Array.from(new Set([...existingGroups, updated.group]))
    : [...existingGroups];
  return { ok: true, hosts, customGroups, updatedHost: updated };
}

export function applyVaultHostDelete(
  existingHosts: Host[],
  hostId: string,
  resolveEffectiveHost?: (host: Host) => Host,
  groupConfigs: GroupConfig[] = [],
): { ok: true; hosts: Host[]; deletedHost: Host } | { ok: false; error: string } {
  const deletedHost = existingHosts.find((host) => host.id === hostId);
  if (!deletedHost) return { ok: false, error: `Host "${hostId}" was not found.` };
  if (findVaultGroupConfigJumpReference(groupConfigs, hostId)) {
    return { ok: false, error: `Host "${hostId}" is still used as a group jump host.` };
  }
  const hosts = existingHosts.filter((host) => host.id !== hostId);
  const jumpGraphIssue = findIntroducedVaultJumpGraphIssue(
    existingHosts,
    hosts,
    resolveEffectiveHost,
  );
  if (jumpGraphIssue?.kind === 'missing' && jumpGraphIssue.jumpHostId === hostId) {
    return { ok: false, error: `Host "${hostId}" is still used as a jump host.` };
  }
  if (jumpGraphIssue) return { ok: false, error: jumpGraphIssue.error };
  return {
    ok: true,
    hosts,
    deletedHost,
  };
}

export function parseVaultHostDraftsInput(
  value: unknown,
): { ok: true; drafts: VaultHostDraft[] } | { ok: false; error: string } {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: 'hosts is required.' };
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false, error: 'hosts must be a JSON array string.' };
    }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'hosts must be a JSON array of host objects.' };
  }
  if (parsed.length === 0) {
    return { ok: false, error: 'hosts array is empty.' };
  }

  return { ok: true, drafts: parsed as VaultHostDraft[] };
}

export function buildVaultHostsFromDrafts(
  drafts: VaultHostDraft[],
): { hosts: Host[]; issues: VaultHostCreateIssue[]; keyPassphrases: VaultHostKeyPassphrase[] } {
  const hosts: Host[] = [];
  const issues: VaultHostCreateIssue[] = [];
  const keyPassphrases: VaultHostKeyPassphrase[] = [];

  drafts.forEach((draft, index) => {
    const built = buildVaultHostFromDraft(draft);
    if (!built.ok) {
      issues.push({ index, error: built.error });
      return;
    }
    hosts.push(built.host);
    const keyPath = parseKeyPath(draft);
    if (keyPath && typeof draft.passphrase === 'string' && draft.passphrase) {
      keyPassphrases.push({ hostId: built.host.id, keyPath, passphrase: draft.passphrase });
    }
  });

  return { hosts, issues, keyPassphrases };
}

export function applyVaultHostCreates(
  existingHosts: Host[],
  existingGroups: string[],
  createdHosts: Host[],
  options?: { skipDuplicates?: boolean },
): {
  hosts: Host[];
  customGroups: string[];
  addedCount: number;
  skippedExistingCount: number;
  addedHosts: Host[];
} {
  const skipDuplicates = options?.skipDuplicates !== false;
  const existingKeys = new Set(existingHosts.map(buildVaultHostMergeKey));
  let newHosts = createdHosts;
  let skippedExistingCount = 0;

  if (skipDuplicates) {
    newHosts = createdHosts.filter((host) => {
      const duplicate = existingKeys.has(buildVaultHostMergeKey(host));
      if (duplicate) skippedExistingCount++;
      return !duplicate;
    });
  }

  const customGroups = Array.from(
    new Set([
      ...existingGroups,
      ...newHosts.map((host) => host.group).filter(Boolean),
    ]),
  ) as string[];

  return {
    hosts: [...existingHosts, ...newHosts].map(sanitizeHost),
    customGroups,
    addedCount: newHosts.length,
    skippedExistingCount,
    addedHosts: newHosts,
  };
}
