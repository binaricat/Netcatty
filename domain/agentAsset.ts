import type { Host } from './models';

export interface RedactedAgentHost {
  id: string;
  label: string;
  hostname: string;
  port?: number;
  username: string;
  protocol?: Host['protocol'];
  group?: string;
  tags: string[];
  os: Host['os'];
  authMethod?: Host['authMethod'];
  hasPassword: boolean;
  hasKey: boolean;
  hasNotes: boolean;
  notesLength: number;
  connectScriptIds?: string[];
  loginScriptId?: string;
  createdAt?: number;
  lastConnectedAt?: number;
  order?: number;
}

const HOST_SECRET_FIELD_NAMES = new Set([
  'password',
  'telnetPassword',
  'privateKey',
  'passphrase',
]);

const SECRET_ARG_TOOL_NAMES = new Set([
  'asset_add',
  'asset_edit',
  'vault_hosts_create',
  'vault_hosts_import',
]);

function hasString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function redactHostForAgent(host: Host): RedactedAgentHost {
  return {
    id: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    protocol: host.protocol,
    group: host.group,
    tags: Array.isArray(host.tags) ? [...host.tags] : [],
    os: host.os,
    authMethod: host.authMethod,
    hasPassword: hasString(host.password) || hasString(host.telnetPassword),
    hasKey: hasString(host.identityFileId)
      || hasString(host.identityId)
      || Boolean(host.identityFilePaths?.length)
      || host.authMethod === 'key'
      || host.authMethod === 'certificate',
    hasNotes: hasString(host.notes),
    notesLength: typeof host.notes === 'string' ? host.notes.length : 0,
    connectScriptIds: host.connectScriptIds ? [...host.connectScriptIds] : undefined,
    loginScriptId: host.loginScriptId,
    createdAt: host.createdAt,
    lastConnectedAt: host.lastConnectedAt,
    order: host.order,
  };
}

function maskUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskUnknown);
  if (!value || typeof value !== 'object') return value;

  const masked: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    masked[key] = HOST_SECRET_FIELD_NAMES.has(key) ? '[REDACTED]' : maskUnknown(entry);
  }
  return masked;
}

function maskJsonString(value: string): string {
  try {
    return JSON.stringify(maskUnknown(JSON.parse(value)));
  } catch {
    return '[REDACTED_JSON_WITH_SECRETS]';
  }
}

export function containsRawHostSecretInput(args: Record<string, unknown> = {}): boolean {
  if (['password', 'telnetPassword', 'privateKey', 'passphrase'].some((key) => hasString(args[key]))) {
    return true;
  }
  return hasString(args.hosts) || hasString(args.text);
}

export function maskSecretToolArgs(
  toolName: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!SECRET_ARG_TOOL_NAMES.has(toolName)) return args;

  const masked = maskUnknown(args) as Record<string, unknown>;
  if (typeof args.hosts === 'string') {
    masked.hosts = maskJsonString(args.hosts);
  }
  if (typeof args.text === 'string') {
    masked.text = '[REDACTED_IMPORT_TEXT]';
  }
  return masked;
}
