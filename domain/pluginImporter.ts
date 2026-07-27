import type { ImporterRecord, JsonValue } from '@netcatty/plugin-contract';
import { sanitizeHost } from './host';
import { isBuiltInHostProtocol, isPluginHostProtocol } from './pluginConnection';
import type { Host, Identity, Snippet, SSHKey } from './models';
import { applyVaultImportDestination, type VaultImportDestination } from './vaultImport';
import { buildVaultHostMergeKey } from './vaultHostCreate';

export interface PluginImporterDrafts {
  hosts: Host[];
  identities: Identity[];
  keys: SSHKey[];
  snippets: Snippet[];
  groups: string[];
  warnings: string[];
  errors: string[];
}

export interface PluginImporterPreviewItem {
  kind: 'host' | 'identity' | 'key' | 'snippet' | 'group';
  label: string;
  detail?: string;
}

export interface PluginImporterSafePreview {
  items: PluginImporterPreviewItem[];
  warnings: string[];
  errors: string[];
  omittedItemCount: number;
  omittedDiagnosticCount: number;
}

const unicodeLength = (value: string): number => [...value].length;
const truncateUnicode = (value: string, maximum: number): string => [...value].slice(0, maximum).join('');

const visiblePreviewText = (value: string, maximum = 512): string => (
  truncateUnicode([...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim(), maximum)
);

export function buildPluginImporterSafePreview(
  drafts: PluginImporterDrafts,
  maximumItems = 50,
  maximumDiagnostics = 20,
): PluginImporterSafePreview {
  const items: PluginImporterPreviewItem[] = [
    ...drafts.hosts.map((host): PluginImporterPreviewItem => ({
      kind: 'host',
      label: visiblePreviewText(host.label),
      detail: visiblePreviewText(host.pluginConnection?.providerId ?? host.hostname, 1024),
    })),
    ...drafts.identities.map((identity): PluginImporterPreviewItem => ({
      kind: 'identity',
      label: visiblePreviewText(identity.label),
      detail: visiblePreviewText(`${identity.username} · ${identity.authMethod}`),
    })),
    ...drafts.keys.map((key): PluginImporterPreviewItem => ({
      kind: 'key',
      label: visiblePreviewText(key.label),
      detail: visiblePreviewText(`${key.type} · ${key.source}`),
    })),
    ...drafts.snippets.map((snippet): PluginImporterPreviewItem => ({
      kind: 'snippet',
      label: visiblePreviewText(snippet.label),
      detail: visiblePreviewText(snippet.kind),
    })),
    ...drafts.groups.map((group): PluginImporterPreviewItem => ({
      kind: 'group',
      label: visiblePreviewText(group),
    })),
  ];
  const diagnostics = [
    ...drafts.warnings.map((message) => ({ kind: 'warning' as const, message: visiblePreviewText(message, 2048) })),
    ...drafts.errors.map((message) => ({ kind: 'error' as const, message: visiblePreviewText(message, 2048) })),
  ];
  const boundedDiagnostics = diagnostics.slice(0, Math.max(0, maximumDiagnostics));
  return {
    items: items.slice(0, Math.max(0, maximumItems)),
    warnings: boundedDiagnostics.filter(({ kind }) => kind === 'warning').map(({ message }) => message),
    errors: boundedDiagnostics.filter(({ kind }) => kind === 'error').map(({ message }) => message),
    omittedItemCount: Math.max(0, items.length - maximumItems),
    omittedDiagnosticCount: Math.max(0, diagnostics.length - maximumDiagnostics),
  };
}

const asObject = (value: JsonValue): Record<string, JsonValue> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
);

const INVALID_FIELD = Symbol('invalid-plugin-importer-field');
type InvalidField = typeof INVALID_FIELD;

const stringValue = (value: JsonValue | undefined, maximum: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result && unicodeLength(result) <= maximum && !result.includes('\0') ? result : undefined;
};

const optionalRawStringValue = (
  object: Record<string, JsonValue>,
  key: string,
  maximum: number,
): string | undefined | InvalidField => {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = object[key];
  return typeof value === 'string' && unicodeLength(value) <= maximum
    ? value
    : INVALID_FIELD;
};

const optionalStringValue = (
  object: Record<string, JsonValue>,
  key: string,
  maximum: number,
): string | undefined | InvalidField => {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  if (typeof object[key] !== 'string') return INVALID_FIELD;
  const result = stringValue(object[key], maximum);
  return result ?? undefined;
};

const optionalBooleanValue = (
  object: Record<string, JsonValue>,
  key: string,
): boolean | undefined | InvalidField => {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  return typeof object[key] === 'boolean' ? object[key] : INVALID_FIELD;
};

const optionalIntegerValue = (
  object: Record<string, JsonValue>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined | InvalidField => {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = object[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : INVALID_FIELD;
};

const optionalEnumValue = <T extends string>(
  object: Record<string, JsonValue>,
  key: string,
  allowed: readonly T[],
): T | undefined | InvalidField => {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = object[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : INVALID_FIELD;
};

const stringArray = (value: JsonValue | undefined, maximumItems = 128): string[] => (
  Array.isArray(value)
    ? [...new Set(value.slice(0, maximumItems).flatMap((item) => {
      const normalized = stringValue(item, 256);
      return normalized ? [normalized] : [];
    }))]
    : []
);

const normalizeHost = (value: JsonValue): Host | null => {
  const object = asObject(value);
  if (!object) return null;
  const hasProtocol = Object.prototype.hasOwnProperty.call(object, 'protocol');
  const protocolValue = hasProtocol ? stringValue(object.protocol, 199) : undefined;
  if (hasProtocol && !protocolValue) return null;
  if (protocolValue && !isBuiltInHostProtocol(protocolValue) && !isPluginHostProtocol(protocolValue)) return null;
  const protocol = protocolValue as Host['protocol'] | undefined;
  const pluginProtocol = isPluginHostProtocol(protocol);
  const providerId = asObject(object.pluginConnection)
    ? stringValue(asObject(object.pluginConnection)?.providerId, 192)
    : undefined;
  const hostname = stringValue(object.hostname, 1024) ?? (pluginProtocol ? providerId : undefined);
  const label = stringValue(object.label, 512) ?? hostname;
  if (!hostname || !label) return null;
  const pluginConnection = Object.prototype.hasOwnProperty.call(object, 'pluginConnection')
    ? asObject(object.pluginConnection)
    : undefined;
  if (pluginConnection === null) return null;
  const sourceCredentialId = pluginConnection
    ? optionalStringValue(pluginConnection, 'credentialId', 256)
    : undefined;
  if (sourceCredentialId === INVALID_FIELD) return null;
  const tags = Object.prototype.hasOwnProperty.call(object, 'tags') && !Array.isArray(object.tags)
    ? null
    : stringArray(object.tags);
  if (!tags) return null;
  const optionalStrings = {
    group: optionalStringValue(object, 'group', 512),
    identityId: optionalStringValue(object, 'identityId', 256),
    identityFileId: optionalStringValue(object, 'identityFileId', 256),
    telnetIdentityId: optionalStringValue(object, 'telnetIdentityId', 256),
    notes: optionalStringValue(object, 'notes', 65_536),
    theme: optionalStringValue(object, 'theme', 256),
    sftpEncoding: optionalStringValue(object, 'sftpEncoding', 64),
  };
  if (Object.values(optionalStrings).some((item) => item === INVALID_FIELD)) return null;
  const optionalBooleans = {
    moshEnabled: optionalBooleanValue(object, 'moshEnabled'),
    etEnabled: optionalBooleanValue(object, 'etEnabled'),
    telnetEnabled: optionalBooleanValue(object, 'telnetEnabled'),
    sftpSudo: optionalBooleanValue(object, 'sftpSudo'),
    requiresMfa: optionalBooleanValue(object, 'requiresMfa'),
    useSshAgent: optionalBooleanValue(object, 'useSshAgent'),
    identitiesOnly: optionalBooleanValue(object, 'identitiesOnly'),
    agentForwarding: optionalBooleanValue(object, 'agentForwarding'),
    x11Forwarding: optionalBooleanValue(object, 'x11Forwarding'),
    showLineTimestamps: optionalBooleanValue(object, 'showLineTimestamps'),
    disableDynamicTabTitle: optionalBooleanValue(object, 'disableDynamicTabTitle'),
    pinned: optionalBooleanValue(object, 'pinned'),
    autoOpenSftpPanel: optionalBooleanValue(object, 'autoOpenSftpPanel'),
    sftpFollowTerminalCwd: optionalBooleanValue(object, 'sftpFollowTerminalCwd'),
  };
  if (Object.values(optionalBooleans).some((item) => item === INVALID_FIELD)) return null;
  const optionalIntegers = {
    port: optionalIntegerValue(object, 'port', 1, 65535),
    telnetPort: optionalIntegerValue(object, 'telnetPort', 1, 65535),
    etPort: optionalIntegerValue(object, 'etPort', 1, 65535),
    keepaliveInterval: optionalIntegerValue(object, 'keepaliveInterval', 0, 3600),
    keepaliveCountMax: optionalIntegerValue(object, 'keepaliveCountMax', 1, 100),
  };
  if (Object.values(optionalIntegers).some((item) => item === INVALID_FIELD)) return null;
  const deviceType = optionalEnumValue(object, 'deviceType', ['general', 'network'] as const);
  if (deviceType === INVALID_FIELD) return null;
  const sftpFileProtocol = optionalEnumValue(object, 'sftpFileProtocol', ['auto', 'sftp', 'scp'] as const);
  if (sftpFileProtocol === INVALID_FIELD) return null;
  const draft = {
    id: crypto.randomUUID(),
    label,
    hostname,
    username: stringValue(object.username, 512) ?? '',
    tags,
    os: ['linux', 'windows', 'macos'].includes(String(object.os)) ? object.os : 'linux',
    createdAt: Date.now(),
    ephemeral: false,
    managedSourceId: undefined,
    ...(protocol ? { protocol } : {}),
    ...(pluginConnection ? { pluginConnection: structuredClone(pluginConnection) } : {}),
    ...(deviceType ? { deviceType } : {}),
    ...(sftpFileProtocol ? { sftpFileProtocol } : {}),
    ...Object.fromEntries(Object.entries(optionalStrings).filter(([, item]) => item !== undefined)),
    ...Object.fromEntries(Object.entries(optionalBooleans).filter(([, item]) => item !== undefined)),
    ...Object.fromEntries(Object.entries(optionalIntegers).filter(([, item]) => item !== undefined)),
  } as unknown as Host;
  const sanitized = sanitizeHost(draft);
  if (!sanitized.hostname || (pluginProtocol && !sanitized.pluginConnection)) return null;
  return sanitized.pluginConnection && sourceCredentialId
    ? {
        ...sanitized,
        pluginConnection: { ...sanitized.pluginConnection, credentialId: sourceCredentialId },
      }
    : sanitized;
};

const normalizeIdentity = (value: JsonValue): Identity | null => {
  const object = asObject(value);
  if (!object) return null;
  const label = stringValue(object.label, 512);
  const username = stringValue(object.username, 512);
  const authMethod = stringValue(object.authMethod, 32);
  const password = optionalRawStringValue(object, 'password', 65_536);
  if (!label || !username || !['password', 'key', 'certificate'].includes(authMethod ?? '')
    || password === INVALID_FIELD) return null;
  return {
    id: crypto.randomUUID(),
    label,
    username,
    authMethod: authMethod as Identity['authMethod'],
    ...(password !== undefined ? { password } : {}),
    ...(stringValue(object.keyId, 256) ? { keyId: stringValue(object.keyId, 256) } : {}),
    created: Date.now(),
  };
};

const normalizeKey = (value: JsonValue): SSHKey | null => {
  const object = asObject(value);
  if (!object) return null;
  const label = stringValue(object.label, 512);
  const type = stringValue(object.type, 32);
  const privateKey = optionalRawStringValue(object, 'privateKey', 2 * 1024 * 1024);
  const publicKey = optionalRawStringValue(object, 'publicKey', 1024 * 1024);
  const certificate = optionalRawStringValue(object, 'certificate', 1024 * 1024);
  const passphrase = optionalRawStringValue(object, 'passphrase', 65_536);
  const filePath = stringValue(object.filePath, 8192);
  if (!label || !['RSA', 'ECDSA', 'ED25519'].includes(type ?? '')
    || [privateKey, publicKey, certificate, passphrase].some((item) => item === INVALID_FIELD)
    || (!privateKey && !filePath)) return null;
  return {
    id: crypto.randomUUID(),
    label,
    type: type as SSHKey['type'],
    privateKey: privateKey ?? '',
    ...(publicKey !== undefined ? { publicKey } : {}),
    ...(certificate !== undefined ? { certificate } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(filePath ? { filePath } : {}),
    source: filePath && !privateKey ? 'reference' : 'imported',
    category: ['key', 'certificate', 'identity'].includes(String(object.category))
      ? object.category as SSHKey['category']
      : 'key',
    created: Date.now(),
  };
};

const normalizeSnippet = (value: JsonValue): Snippet | null => {
  const object = asObject(value);
  if (!object) return null;
  const label = stringValue(object.label, 512);
  const command = optionalRawStringValue(object, 'command', 1024 * 1024);
  if (!label || !command || command === INVALID_FIELD || command.includes('\0')) return null;
  return {
    id: crypto.randomUUID(),
    label,
    command,
    tags: stringArray(object.tags),
    kind: object.kind === 'script' ? 'script' : 'snippet',
    ...(stringValue(object.description, 4096) ? { description: stringValue(object.description, 4096) } : {}),
  };
};

export function normalizePluginImporterRecords(records: ReadonlyArray<ImporterRecord>): PluginImporterDrafts {
  const result: PluginImporterDrafts = {
    hosts: [], identities: [], keys: [], snippets: [], groups: [], warnings: [], errors: [],
  };
  const keyIds = new Map<string, string | null>();
  const identityIds = new Map<string, string | null>();
  const registerSourceId = (
    index: Map<string, string | null>,
    sourceId: string,
    id: string,
    kind: 'identity' | 'key',
  ): void => {
    if (!index.has(sourceId)) {
      index.set(sourceId, id);
      return;
    }
    if (index.get(sourceId) !== null) {
      result.errors.push(`Importer returned a duplicate ${kind} source ID.`);
    }
    index.set(sourceId, null);
  };
  const sourceIds = (value: JsonValue): string | undefined => {
    const object = asObject(value);
    return object ? stringValue(object.id, 256) : undefined;
  };
  for (const record of records) {
    if (record.type === 'warning') {
      result.warnings.push(record.message);
      continue;
    }
    if (record.type === 'error') {
      result.errors.push(record.message);
      continue;
    }
    if (record.type !== 'draft') continue;
    const { kind, value } = record.draft;
    if (kind === 'group') {
      const object = asObject(value);
      const group = typeof value === 'string'
        ? stringValue(value, 512)
        : object ? stringValue(object.path ?? object.label, 512) : undefined;
      if (group) result.groups.push(group);
      else result.errors.push('Importer returned an invalid group draft.');
      continue;
    }
    const normalized = kind === 'host'
      ? normalizeHost(value)
      : kind === 'identity'
        ? normalizeIdentity(value)
        : kind === 'key'
          ? normalizeKey(value)
          : normalizeSnippet(value);
    if (!normalized) {
      result.errors.push(`Importer returned an invalid ${kind} draft.`);
      continue;
    }
    if (kind === 'host') result.hosts.push(normalized as Host);
    else if (kind === 'identity') {
      const identity = normalized as Identity;
      result.identities.push(identity);
      const sourceId = sourceIds(value);
      if (sourceId) registerSourceId(identityIds, sourceId, identity.id, 'identity');
    } else if (kind === 'key') {
      const key = normalized as SSHKey;
      result.keys.push(key);
      const sourceId = sourceIds(value);
      if (sourceId) registerSourceId(keyIds, sourceId, key.id, 'key');
    }
    else result.snippets.push(normalized as Snippet);
  }
  const resolveReference = (
    index: Map<string, string | null>,
    sourceId: string | undefined,
    label: string,
  ): string | undefined => {
    if (!sourceId) return undefined;
    const resolved = index.get(sourceId);
    if (typeof resolved === 'string') return resolved;
    result.errors.push(resolved === null
      ? `Importer returned an ambiguous ${label} reference.`
      : `Importer returned an unresolved ${label} reference.`);
    return undefined;
  };
  result.identities = result.identities.map((identity) => {
    const keyId = resolveReference(keyIds, identity.keyId, 'identity key');
    return {
      ...identity,
      ...(typeof keyId === 'string' ? { keyId } : { keyId: undefined }),
    };
  });
  result.hosts = result.hosts.map((host) => {
    const sourceCredentialId = host.pluginConnection?.credentialId;
    const identityCredentialId = sourceCredentialId ? identityIds.get(sourceCredentialId) : undefined;
    const keyCredentialId = sourceCredentialId ? keyIds.get(sourceCredentialId) : undefined;
    const hasAmbiguousCredential = identityCredentialId === null
      || keyCredentialId === null
      || (typeof identityCredentialId === 'string' && typeof keyCredentialId === 'string');
    const credentialId = hasAmbiguousCredential
      ? undefined
      : identityCredentialId ?? keyCredentialId;
    if (sourceCredentialId && !credentialId) {
      result.errors.push(hasAmbiguousCredential
        ? 'Importer returned an ambiguous plugin credential reference.'
        : 'Importer returned an unresolved plugin credential reference.');
    }
    const identityId = resolveReference(identityIds, host.identityId, 'host identity');
    const telnetIdentityId = resolveReference(identityIds, host.telnetIdentityId, 'host Telnet identity');
    const identityFileId = resolveReference(keyIds, host.identityFileId, 'host key');
    return {
      ...host,
      ...(typeof identityId === 'string'
        ? { identityId }
        : { identityId: undefined }),
      ...(typeof telnetIdentityId === 'string'
        ? { telnetIdentityId }
        : { telnetIdentityId: undefined }),
      ...(typeof identityFileId === 'string'
        ? { identityFileId }
        : { identityFileId: undefined }),
      ...(host.pluginConnection
        ? {
            pluginConnection: {
              ...host.pluginConnection,
              ...(credentialId ? { credentialId } : { credentialId: undefined }),
            },
          }
        : {}),
    };
  });
  result.groups = [...new Set(result.groups)];
  return result;
}

export interface PluginImporterMergeResult {
  hosts: Host[];
  identities: Identity[];
  keys: SSHKey[];
  snippets: Snippet[];
  customGroups: string[];
  duplicateCount: number;
  addedCount: number;
}

export function applyPluginImporterDestination(
  merged: PluginImporterMergeResult,
  existingHostCount: number,
  destination?: VaultImportDestination,
  existingCustomGroups: ReadonlyArray<string> = [],
): PluginImporterMergeResult {
  if (!destination || destination.mode === 'preserve') return merged;
  const splitAt = Math.max(0, Math.min(existingHostCount, merged.hosts.length));
  const existingHosts = merged.hosts.slice(0, splitAt);
  const importedHosts = merged.hosts.slice(splitAt);
  const targeted = applyVaultImportDestination({
    hosts: importedHosts,
    groups: [],
    issues: [],
    stats: {
      parsed: importedHosts.length,
      imported: importedHosts.length,
      skipped: 0,
      duplicates: 0,
    },
  }, destination);
  const existingGroupSet = new Set([
    ...existingCustomGroups,
    ...existingHosts.flatMap((host) => host.group ? [host.group] : []),
  ]);
  const previousAddedGroupCount = merged.customGroups.filter(
    (group) => !existingGroupSet.has(group),
  ).length;
  const customGroups = [...new Set([...existingCustomGroups, ...targeted.groups])];
  const nextAddedGroupCount = customGroups.filter(
    (group) => !existingGroupSet.has(group),
  ).length;
  return {
    ...merged,
    hosts: [...existingHosts, ...targeted.hosts],
    customGroups,
    addedCount: merged.addedCount - previousAddedGroupCount + nextAddedGroupCount,
  };
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

const keyFingerprint = (key: SSHKey): string => stableJson({
  type: key.type,
  privateKey: key.privateKey,
  publicKey: key.publicKey,
  certificate: key.certificate,
  filePath: key.filePath,
});

const identityFingerprint = (identity: Identity): string => stableJson({
  username: identity.username.trim().toLowerCase(),
  authMethod: identity.authMethod,
  keyId: identity.keyId,
  password: identity.password,
});

const hostFingerprint = (host: Host): string => host.pluginConnection
  ? stableJson({
    protocol: host.protocol,
    providerId: host.pluginConnection.providerId,
    authenticationProviderId: host.pluginConnection.authenticationProviderId,
    credentialId: host.pluginConnection.credentialId,
    configuration: host.pluginConnection.configuration,
    username: host.username.trim().toLowerCase(),
    identityId: host.identityId,
    telnetIdentityId: host.telnetIdentityId,
    identityFileId: host.identityFileId,
  })
  : buildVaultHostMergeKey(host);

const snippetFingerprint = (snippet: Snippet): string => stableJson({
  label: snippet.label.trim().toLowerCase(),
  kind: snippet.kind,
  command: snippet.command,
});

export function mergePluginImporterDrafts(
  existing: Pick<PluginImporterMergeResult, 'hosts' | 'identities' | 'keys' | 'snippets' | 'customGroups'>,
  drafts: PluginImporterDrafts,
): PluginImporterMergeResult {
  let duplicateCount = 0;
  const keyByFingerprint = new Map(existing.keys.map((key) => [keyFingerprint(key), key]));
  const keyIdRemap = new Map<string, string>();
  const addedKeys: SSHKey[] = [];
  for (const key of drafts.keys) {
    const fingerprint = keyFingerprint(key);
    const duplicate = keyByFingerprint.get(fingerprint);
    if (duplicate) {
      duplicateCount += 1;
      keyIdRemap.set(key.id, duplicate.id);
      continue;
    }
    keyByFingerprint.set(fingerprint, key);
    addedKeys.push(key);
  }

  const identityByFingerprint = new Map(existing.identities.map((identity) => [identityFingerprint(identity), identity]));
  const identityIdRemap = new Map<string, string>();
  const addedIdentities: Identity[] = [];
  for (const source of drafts.identities) {
    const identity = source.keyId && keyIdRemap.has(source.keyId)
      ? { ...source, keyId: keyIdRemap.get(source.keyId) }
      : source;
    const fingerprint = identityFingerprint(identity);
    const duplicate = identityByFingerprint.get(fingerprint);
    if (duplicate) {
      duplicateCount += 1;
      identityIdRemap.set(source.id, duplicate.id);
      continue;
    }
    identityByFingerprint.set(fingerprint, identity);
    addedIdentities.push(identity);
  }

  const hostFingerprints = new Set(existing.hosts.map(hostFingerprint));
  const addedHosts: Host[] = [];
  for (const source of drafts.hosts) {
    const pluginCredentialId = source.pluginConnection?.credentialId;
    const remappedPluginCredentialId = pluginCredentialId
      ? identityIdRemap.get(pluginCredentialId) ?? keyIdRemap.get(pluginCredentialId)
      : undefined;
    const host = sanitizeHost({
      ...source,
      ...(source.identityId && identityIdRemap.has(source.identityId)
        ? { identityId: identityIdRemap.get(source.identityId) }
        : {}),
      ...(source.telnetIdentityId && identityIdRemap.has(source.telnetIdentityId)
        ? { telnetIdentityId: identityIdRemap.get(source.telnetIdentityId) }
        : {}),
      ...(source.identityFileId && keyIdRemap.has(source.identityFileId)
        ? { identityFileId: keyIdRemap.get(source.identityFileId) }
        : {}),
      ...(source.pluginConnection && remappedPluginCredentialId
        ? {
            pluginConnection: {
              ...source.pluginConnection,
              credentialId: remappedPluginCredentialId,
            },
          }
        : {}),
    });
    const fingerprint = hostFingerprint(host);
    if (hostFingerprints.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    hostFingerprints.add(fingerprint);
    addedHosts.push(host);
  }

  const snippetFingerprints = new Set(existing.snippets.map(snippetFingerprint));
  const addedSnippets = drafts.snippets.filter((snippet) => {
    const fingerprint = snippetFingerprint(snippet);
    if (snippetFingerprints.has(fingerprint)) {
      duplicateCount += 1;
      return false;
    }
    snippetFingerprints.add(fingerprint);
    return true;
  });
  const customGroups = [...new Set([
    ...existing.customGroups,
    ...drafts.groups,
    ...addedHosts.flatMap((host) => host.group ? [host.group] : []),
  ])];
  const addedCount = addedKeys.length + addedIdentities.length + addedHosts.length + addedSnippets.length
    + Math.max(0, customGroups.length - existing.customGroups.length);
  return {
    keys: [...existing.keys, ...addedKeys],
    identities: [...existing.identities, ...addedIdentities],
    hosts: [...existing.hosts, ...addedHosts],
    snippets: [...existing.snippets, ...addedSnippets],
    customGroups,
    duplicateCount,
    addedCount,
  };
}
