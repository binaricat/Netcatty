import type { GroupConfig, Host, Identity, ManagedSource, ProxyProfile } from './models';
import { normalizeAgentCharset } from './vaultHostConnectionSettings';
import { applyGroupDefaults, resolveGroupDefaults } from './groupConfig';
import {
  findIntroducedVaultJumpGraphIssue,
  findVaultGroupConfigJumpReference,
} from './vaultJumpGraph';

type GroupState = {
  groups: string[];
  configs: GroupConfig[];
  hosts: Host[];
  managedSources: ManagedSource[];
};

type Result = { ok: true; state: GroupState; config?: GroupConfig } | { ok: false; error: string };

const normalizePath = (value: unknown): string => String(value ?? '')
  .replace(/\\/g, '/')
  .split('/')
  .map((part) => part.trim())
  .filter(Boolean)
  .join('/');

function parseDefaults(value: unknown): Record<string, unknown> | { error: string } {
  if (value === undefined || value === null || value === '') return {};
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return { error: 'defaults must be a JSON object.' };
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { error: 'defaults must be a JSON object.' };
  } catch {
    return { error: 'defaults must be a valid JSON object.' };
  }
}

const bool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return undefined;
};

const resolveEffectiveHostForConfigs = (configs: GroupConfig[]) => (host: Host): Host => host.group
  ? applyGroupDefaults(host, resolveGroupDefaults(host.group, configs))
  : host;

const hasInvalidTransport = (value: Pick<Host, 'protocol' | 'moshEnabled' | 'etEnabled'>): boolean => (
  Boolean(value.moshEnabled && value.etEnabled) || Boolean(
    value.protocol !== undefined
    && value.protocol !== 'ssh'
    && (value.moshEnabled || value.etEnabled)
  )
);

const collectTransportIssueKeys = (
  state: Pick<GroupState, 'groups' | 'configs' | 'hosts'>,
  canonicalGroupPath: (path: string) => string = (path) => path,
): Set<string> => {
  const issues = new Set<string>();
  const groupPaths = new Set([...state.groups, ...state.configs.map((config) => config.path)]);
  for (const groupPath of groupPaths) {
    if (hasInvalidTransport(resolveGroupDefaults(groupPath, state.configs))) {
      issues.add(`group:${canonicalGroupPath(groupPath)}`);
    }
  }
  const resolveHost = resolveEffectiveHostForConfigs(state.configs);
  for (const host of state.hosts) {
    if (hasInvalidTransport(resolveHost(host))) issues.add(`host:${host.id}`);
  }
  return issues;
};

const findIntroducedJumpGraphIssue = (before: GroupState, after: GroupState) =>
  findIntroducedVaultJumpGraphIssue(
    before.hosts,
    after.hosts,
    resolveEffectiveHostForConfigs(before.configs),
    resolveEffectiveHostForConfigs(after.configs),
  );

const findReferencedJumpHostProtocolRegression = (
  before: Pick<GroupState, 'configs' | 'hosts'>,
  after: Pick<GroupState, 'configs' | 'hosts'>,
): string | undefined => {
  const referencedHostIds = new Set(
    after.configs.flatMap((config) => config.hostChain?.hostIds ?? []),
  );
  const resolveBefore = resolveEffectiveHostForConfigs(before.configs);
  const resolveAfter = resolveEffectiveHostForConfigs(after.configs);

  return [...referencedHostIds].find((hostId) => {
    const beforeHost = before.hosts.find((host) => host.id === hostId);
    const afterHost = after.hosts.find((host) => host.id === hostId);
    if (!beforeHost || !afterHost) return false;
    const beforeProtocol = resolveBefore(beforeHost).protocol;
    const afterProtocol = resolveAfter(afterHost).protocol;
    return (beforeProtocol === undefined || beforeProtocol === 'ssh')
      && afterProtocol !== undefined
      && afterProtocol !== 'ssh';
  });
};

/**
 * removeDefaults entries and the group config keys each one deletes, so the
 * parent group (or the app default) applies again. Credentials stay GUI-only.
 */
const REMOVABLE_GROUP_DEFAULTS: Record<string, readonly (keyof GroupConfig)[]> = {
  proxy: ['proxyProfileId', 'proxyConfig'],
  jumpHostIds: ['hostChain'],
  startupCommand: ['startupCommand'],
  startupCommandRunMode: ['startupCommandRunMode'],
  environmentVariables: ['environmentVariables'],
  moshEnabled: ['moshEnabled'],
  moshServerPath: ['moshServerPath'],
  etEnabled: ['etEnabled'],
  etPort: ['etPort'],
  deviceType: ['deviceType'],
  charset: ['charset'],
  backspaceBehavior: ['backspaceBehavior'],
};

const REMOVE_CONFLICT_KEYS: Record<string, readonly string[]> = {
  proxy: ['proxyProfileId'],
};

function parseRemoveDefaults(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  let value: unknown = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { value = JSON.parse(trimmed); } catch { return { error: 'removeDefaults must be a valid JSON array.' }; }
    } else {
      value = trimmed ? trimmed.split(',') : [];
    }
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { error: 'removeDefaults must be an array of field names.' };
  }
  const fields = Array.from(new Set((value as string[]).map((entry) => entry.trim()).filter(Boolean)));
  const unknown = fields.find((field) => !Object.hasOwn(REMOVABLE_GROUP_DEFAULTS, field));
  if (unknown) {
    return {
      error: `removeDefaults cannot remove "${unknown}". Allowed: ${Object.keys(REMOVABLE_GROUP_DEFAULTS).join(', ')}.`,
    };
  }
  return fields;
}

export function patchGroupConfig(
  current: GroupConfig,
  rawDefaults: unknown,
  identities: Identity[],
  proxyProfiles: ProxyProfile[],
  hosts: Host[],
  resolveEffectiveHost?: (host: Host) => Host,
  rawRemoveDefaults?: unknown,
): { ok: true; config: GroupConfig } | { ok: false; error: string } {
  const defaults = parseDefaults(rawDefaults);
  if ('error' in defaults) return { ok: false, error: String(defaults.error) };
  const removeDefaults = parseRemoveDefaults(rawRemoveDefaults);
  if ('error' in removeDefaults) return { ok: false, error: removeDefaults.error };
  for (const field of removeDefaults) {
    const conflict = [field, ...(REMOVE_CONFLICT_KEYS[field] ?? [])].find((key) => Object.hasOwn(defaults, key));
    if (conflict) return { ok: false, error: `${conflict} cannot be set and removed in the same update.` };
  }
  if (Object.hasOwn(defaults, 'authMethod')) {
    return { ok: false, error: 'authMethod cannot be set on a group here; choose the group key or identity in Group Details.' };
  }
  const next: GroupConfig = { ...current };
  for (const field of removeDefaults) {
    for (const key of REMOVABLE_GROUP_DEFAULTS[field]) delete next[key];
  }
  if (Object.hasOwn(defaults, 'deviceType')) {
    const deviceType = String(defaults.deviceType ?? '').trim().toLowerCase();
    if (deviceType !== 'general' && deviceType !== 'network') {
      return { ok: false, error: 'deviceType must be general or network.' };
    }
    next.deviceType = deviceType;
  }
  if (Object.hasOwn(defaults, 'charset')) {
    const charset = normalizeAgentCharset(defaults.charset);
    if (!charset) {
      return { ok: false, error: 'charset must be UTF-8 or GB18030 (GBK and GB2312 are saved as GB18030). Use removeDefaults ["charset"] to inherit.' };
    }
    next.charset = charset;
  }
  if (Object.hasOwn(defaults, 'backspaceBehavior')) {
    if (String(defaults.backspaceBehavior ?? '').trim().toLowerCase() !== 'ctrl-h') {
      return { ok: false, error: 'backspaceBehavior must be ctrl-h. Use removeDefaults ["backspaceBehavior"] to inherit.' };
    }
    next.backspaceBehavior = 'ctrl-h';
  }
  if (Object.hasOwn(defaults, 'username')) {
    next.username = String(defaults.username ?? '');
    if (!Object.hasOwn(defaults, 'identityId') && current.identityId) {
      next.identityId = '';
      next.authMethod = undefined;
      next.password = undefined;
      next.savePassword = undefined;
      next.identityFileId = undefined;
      next.identityFilePaths = undefined;
    }
  }
  if (Object.hasOwn(defaults, 'startupCommand')) next.startupCommand = String(defaults.startupCommand ?? '');
  if (Object.hasOwn(defaults, 'moshServerPath')) next.moshServerPath = String(defaults.moshServerPath ?? '');
  if (Object.hasOwn(defaults, 'identityId')) {
    const identityId = String(defaults.identityId ?? '');
    const identity = identities.find((item) => item.id === identityId);
    if (identityId && !identity) return { ok: false, error: `Identity "${identityId}" was not found.` };
    next.identityId = identityId;
    if (identity) {
      next.username = identity.username;
      next.authMethod = identity.authMethod;
      next.password = undefined;
      next.savePassword = undefined;
      next.identityFileId = undefined;
      next.identityFilePaths = undefined;
    } else {
      if (!Object.hasOwn(defaults, 'username')) next.username = undefined;
      next.authMethod = undefined;
    }
  }
  if (Object.hasOwn(defaults, 'proxyProfileId')) {
    const proxyProfileId = String(defaults.proxyProfileId ?? '');
    if (proxyProfileId && !proxyProfiles.some((profile) => profile.id === proxyProfileId)) {
      return { ok: false, error: `Proxy profile "${proxyProfileId}" was not found.` };
    }
    // Like Group Details: an empty value removes the group proxy so a parent
    // group proxy (or the global default) applies, instead of blocking it.
    next.proxyProfileId = proxyProfileId || undefined;
    next.proxyConfig = undefined;
  }
  if (Object.hasOwn(defaults, 'jumpHostIds')) {
    let ids: unknown = defaults.jumpHostIds;
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { return { ok: false, error: 'jumpHostIds must be a JSON array.' }; }
    }
    if (!Array.isArray(ids)) return { ok: false, error: 'jumpHostIds must be an array.' };
    const hostIds = ids.map(String).map((id) => id.trim()).filter(Boolean);
    if (new Set(hostIds).size !== hostIds.length) return { ok: false, error: 'jumpHostIds must not contain duplicates.' };
    const missing = hostIds.find((id) => !hosts.some((host) => host.id === id));
    if (missing) return { ok: false, error: `Jump host "${missing}" was not found.` };
    const unsupported = hostIds.find((id) => {
      const host = hosts.find((candidate) => candidate.id === id);
      if (!host) return false;
      const effectiveHost = resolveEffectiveHost?.(host) ?? host;
      return effectiveHost.protocol !== undefined && effectiveHost.protocol !== 'ssh';
    });
    if (unsupported) return { ok: false, error: `Jump host "${unsupported}" does not support SSH jump connections.` };
    next.hostChain = { hostIds };
  }
  if (Object.hasOwn(defaults, 'environmentVariables')) {
    const raw = defaults.environmentVariables;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'environmentVariables must be a JSON object.' };
    }
    next.environmentVariables = Object.entries(raw).map(([name, value]) => ({ name, value: String(value ?? '') }));
  }
  for (const key of ['moshEnabled', 'etEnabled'] as const) {
    if (Object.hasOwn(defaults, key)) {
      const parsed = bool(defaults[key]);
      if (parsed === undefined) return { ok: false, error: `${key} must be true or false.` };
      next[key] = parsed;
    }
  }
  if (next.moshEnabled && next.etEnabled) {
    return { ok: false, error: 'Mosh and ET cannot both be enabled.' };
  }
  if (Object.hasOwn(defaults, 'etPort')) {
    const etPort = Number(defaults.etPort);
    if (!Number.isInteger(etPort) || etPort < 1 || etPort > 65535) return { ok: false, error: 'etPort must be between 1 and 65535.' };
    next.etPort = etPort;
  }
  return { ok: true, config: next };
}

export function upsertGroup(
  state: GroupState,
  pathValue: unknown,
  defaults: unknown,
  identities: Identity[],
  proxyProfiles: ProxyProfile[],
  options: { create?: boolean; newPath?: unknown; removeDefaults?: unknown } = {},
): Result {
  const path = normalizePath(pathValue);
  if (!path) return { ok: false, error: 'path is required.' };
  if (options.create && state.groups.includes(path)) return { ok: false, error: `Group "${path}" already exists.` };
  if (!options.create && !state.groups.includes(path)) return { ok: false, error: `Group "${path}" was not found.` };
  const newPath = normalizePath(options.newPath ?? path);
  if (!newPath) return { ok: false, error: 'newPath must not be empty.' };
  if (newPath.startsWith(`${path}/`)) return { ok: false, error: 'A group cannot be moved inside itself.' };
  if (newPath !== path) {
    const belongsToRenamedTree = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
    const renameCandidate = (candidate: string) => candidate === path
      ? newPath
      : `${newPath}${candidate.slice(path.length)}`;
    const occupiedPaths = new Set([
      ...state.groups.filter((candidate) => !belongsToRenamedTree(candidate)),
      ...state.configs.map((config) => config.path).filter((candidate) => !belongsToRenamedTree(candidate)),
    ]);
    const collision = [...state.groups, ...state.configs.map((config) => config.path)]
      .filter(belongsToRenamedTree)
      .map(renameCandidate)
      .find((candidate) => occupiedPaths.has(candidate));
    if (collision) return { ok: false, error: `Group "${collision}" already exists.` };
  }
  const rename = (candidate: string) => candidate === path
    ? newPath
    : candidate.startsWith(`${path}/`) ? `${newPath}${candidate.slice(path.length)}` : candidate;
  const current = state.configs.find((config) => config.path === path) ?? { path };
  const prospectiveConfig = { ...current, path: newPath };
  const prospectiveConfigs = [
    ...state.configs
      .filter((config) => config.path !== path)
      .map((config) => ({ ...config, path: rename(config.path) })),
    prospectiveConfig,
  ];
  const resolveProspectiveHost = (host: Host): Host => {
    const prospectiveHost = host.group ? { ...host, group: rename(host.group) } : host;
    if (!prospectiveHost.group) return prospectiveHost;
    return applyGroupDefaults(
      prospectiveHost,
      resolveGroupDefaults(prospectiveHost.group, prospectiveConfigs),
    );
  };
  const patched = patchGroupConfig(
    prospectiveConfig,
    defaults,
    identities,
    proxyProfiles,
    state.hosts,
    resolveProspectiveHost,
    options.removeDefaults,
  );
  if ('error' in patched) return { ok: false, error: patched.error };
  const groups = options.create
    ? Array.from(new Set([...state.groups, newPath]))
    : Array.from(new Set(state.groups.map(rename)));
  const configs = [
    ...state.configs.filter((config) => config.path !== path).map((config) => ({ ...config, path: rename(config.path) })),
    patched.config,
  ];
  const nextState: GroupState = {
    groups,
    configs,
    hosts: state.hosts.map((host) => host.group ? { ...host, group: rename(host.group) } : host),
    managedSources: state.managedSources.map((source) => ({ ...source, groupName: rename(source.groupName) })),
  };
  const beforeTransportIssues = collectTransportIssueKeys(state);
  const renamedGroupPaths = new Map(
    [...state.groups, ...state.configs.map((config) => config.path)]
      .filter((candidate) => candidate === path || candidate.startsWith(`${path}/`))
      .map((candidate) => [rename(candidate), candidate]),
  );
  const afterTransportIssues = collectTransportIssueKeys(
    nextState,
    (groupPath) => renamedGroupPaths.get(groupPath) ?? groupPath,
  );
  const introducedTransportIssue = [...afterTransportIssues]
    .find((issue) => !beforeTransportIssues.has(issue));
  if (introducedTransportIssue) {
    return { ok: false, error: `${introducedTransportIssue} has incompatible inherited Mosh, ET, or protocol settings.` };
  }
  const regressedJumpHostId = findReferencedJumpHostProtocolRegression(state, nextState);
  if (regressedJumpHostId) {
    return { ok: false, error: `Host "${regressedJumpHostId}" is still used as a group jump host and must keep an SSH connection type.` };
  }
  const jumpGraphIssue = findIntroducedJumpGraphIssue(state, nextState);
  if (jumpGraphIssue) return { ok: false, error: jumpGraphIssue.error };
  return {
    ok: true,
    state: nextState,
    config: patched.config,
  };
}

export function deleteGroup(state: GroupState, pathValue: unknown, deleteHosts: boolean): Result {
  const path = normalizePath(pathValue);
  if (!path || !state.groups.includes(path)) return { ok: false, error: `Group "${path}" was not found.` };
  if (state.managedSources.some((source) => source.groupName === path || source.groupName.startsWith(`${path}/`))) {
    return { ok: false, error: 'Managed groups must be unmanaged before the AI can delete them.' };
  }
  const inside = (candidate?: string) => Boolean(candidate && (candidate === path || candidate.startsWith(`${path}/`)));
  const hasManagedParent = state.managedSources.some((source) => path.startsWith(`${source.groupName}/`));
  const nextState: GroupState = {
    groups: state.groups.filter((group) => !inside(group)),
    configs: state.configs.filter((config) => !inside(config.path)),
    hosts: deleteHosts
      ? state.hosts.filter((host) => !inside(host.group))
      : state.hosts.map((host) => inside(host.group)
        ? { ...host, group: undefined, ...(hasManagedParent ? {} : { managedSourceId: undefined }) }
        : host),
    managedSources: state.managedSources,
  };
  const deletedHostIds = state.hosts
    .filter((host) => !nextState.hosts.some((candidate) => candidate.id === host.id))
    .map((host) => host.id);
  const referencedDeletedHostId = deletedHostIds.find((hostId) => (
    findVaultGroupConfigJumpReference(nextState.configs, hostId)
  ));
  if (referencedDeletedHostId) {
    return { ok: false, error: `Host "${referencedDeletedHostId}" is still used as a group jump host.` };
  }
  const jumpGraphIssue = findIntroducedJumpGraphIssue(state, nextState);
  if (jumpGraphIssue) return { ok: false, error: jumpGraphIssue.error };
  return { ok: true, state: nextState };
}
