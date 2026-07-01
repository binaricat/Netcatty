import type { Host, HostProtocol } from './models';
import { sanitizeHost } from './host';

const DEFAULT_SSH_PORT = 22;

export type VaultHostDraftProtocol = Exclude<HostProtocol, 'mosh' | 'et' | 'serial'>;

export interface VaultHostDraft {
  label?: unknown;
  hostname?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  group?: unknown;
  tags?: unknown;
  notes?: unknown;
  protocol?: unknown;
}

export interface VaultHostCreateIssue {
  index: number;
  error: string;
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

const parsePort = (raw: unknown): number | undefined => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const port = Math.trunc(raw);
    return port >= 1 && port <= 65535 ? port : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const port = parseInt(trimmed, 10);
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined;
};

const parseTags = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(raw.map((entry) => String(entry).trim()).filter(Boolean)),
    );
  }
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,;，]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const buildVaultHostMergeKey = (
  host: Pick<Host, 'hostname' | 'port' | 'username' | 'protocol'>,
): string =>
  `${(host.protocol ?? 'ssh').toLowerCase()}|${host.hostname.toLowerCase()}|${host.port}|${(host.username ?? '').toLowerCase()}`;

export function buildVaultHostFromDraft(
  draft: VaultHostDraft,
): { ok: true; host: Host } | { ok: false; error: string } {
  const hostname = typeof draft.hostname === 'string' ? draft.hostname.trim() : '';
  if (!hostname) {
    return { ok: false, error: 'hostname is required.' };
  }

  const protocol = normalizeProtocol(draft.protocol) ?? 'ssh';
  const port = parsePort(draft.port) ?? (protocol === 'telnet' ? 23 : DEFAULT_SSH_PORT);
  const label = typeof draft.label === 'string' && draft.label.trim()
    ? draft.label.trim()
    : hostname;
  const username = typeof draft.username === 'string' ? draft.username.trim() : '';
  const password = typeof draft.password === 'string' && draft.password ? draft.password : undefined;
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
      group: normalizeGroupPath(draft.group),
      tags: parseTags(draft.tags),
      os: 'linux',
      protocol,
      createdAt: now,
      ...(notes ? { notes } : {}),
    },
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
): { hosts: Host[]; issues: VaultHostCreateIssue[] } {
  const hosts: Host[] = [];
  const issues: VaultHostCreateIssue[] = [];

  drafts.forEach((draft, index) => {
    const built = buildVaultHostFromDraft(draft);
    if (!built.ok) {
      issues.push({ index, error: built.error });
      return;
    }
    hosts.push(built.host);
  });

  return { hosts, issues };
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
