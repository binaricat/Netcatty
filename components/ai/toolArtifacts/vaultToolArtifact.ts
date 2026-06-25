export type VaultToolArtifact =
  | {
      kind: 'vault.note';
      noteId: string;
      title: string;
      group?: string;
    }
  | {
      kind: 'vault.host';
      hostId: string;
      label: string;
      hostname: string;
      port?: number;
      group?: string;
    }
  | {
      kind: 'vault.hosts.batch';
      sourceTool?: 'vault_hosts_create' | 'vault_hosts_import';
      addedCount: number;
      dryRun?: boolean;
      preview: Array<{ hostId?: string; label?: string; hostname?: string }>;
    }
  | {
      kind: 'vault.summary';
      section: 'notes' | 'hosts';
      count: number;
    }
  | {
      kind: 'error';
      message: string;
    };

const VAULT_ARTIFACT_TOOL_NAMES = new Set([
  'vault_notes_create',
  'vault_notes_update',
  'vault_notes_get',
  'vault_notes_list',
  'vault_hosts_create',
  'vault_hosts_import',
  'vault_hosts_list',
  'host_get',
]);

function parseResultPayload(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseNoteArtifact(note: unknown): VaultToolArtifact | null {
  if (!note || typeof note !== 'object') return null;
  const record = note as Record<string, unknown>;
  const noteId = readString(record.id);
  const title = readString(record.title);
  if (!noteId || !title) return null;
  return {
    kind: 'vault.note',
    noteId,
    title,
    group: readString(record.group),
  };
}

function parseHostArtifact(host: unknown): VaultToolArtifact | null {
  if (!host || typeof host !== 'object') return null;
  const record = host as Record<string, unknown>;
  const hostId = readString(record.id);
  const hostname = readString(record.hostname);
  if (!hostId || !hostname) return null;
  return {
    kind: 'vault.host',
    hostId,
    label: readString(record.label) ?? hostname,
    hostname,
    port: readNumber(record.port),
    group: readString(record.group),
  };
}

function parsePreviewHosts(value: unknown): Array<{ hostId?: string; label?: string; hostname?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const hostname = readString(record.hostname);
      if (!hostname) return null;
      return {
        hostId: readString(record.id),
        label: readString(record.label),
        hostname,
      };
    })
    .filter((entry): entry is { hostId?: string; label?: string; hostname: string } => entry !== null);
}

export function isVaultArtifactToolName(toolName: string): boolean {
  return VAULT_ARTIFACT_TOOL_NAMES.has(toolName);
}

export function parseVaultToolArtifact(
  toolName: string,
  result: unknown,
): VaultToolArtifact | null {
  if (!isVaultArtifactToolName(toolName)) return null;

  const payload = parseResultPayload(result);
  if (!payload) return null;

  if (payload.ok === false || payload.isError === true) {
    const message = readString(payload.error) ?? 'Operation failed.';
    return { kind: 'error', message };
  }

  switch (toolName) {
    case 'vault_notes_create':
    case 'vault_notes_update':
    case 'vault_notes_get':
      return parseNoteArtifact(payload.note);
    case 'vault_notes_list': {
      const notes = Array.isArray(payload.notes) ? payload.notes : [];
      return { kind: 'vault.summary', section: 'notes', count: notes.length };
    }
    case 'vault_hosts_create':
    case 'vault_hosts_import': {
      const preview = parsePreviewHosts(payload.previewHosts);
      const addedCount = readNumber(payload.addedCount)
        ?? (payload.dryRun === true ? readNumber(payload.validCount) : undefined)
        ?? preview.length;
      if (addedCount <= 0 && preview.length === 0) return null;

      const dryRun = payload.dryRun === true;
      if (!dryRun && addedCount === 1 && preview.length === 1 && preview[0].hostname) {
        const single = preview[0];
        if (single.hostId) {
          return {
            kind: 'vault.host',
            hostId: single.hostId,
            label: single.label ?? single.hostname,
            hostname: single.hostname,
          };
        }
      }

      return {
        kind: 'vault.hosts.batch',
        sourceTool: toolName === 'vault_hosts_import' ? 'vault_hosts_import' : 'vault_hosts_create',
        addedCount,
        dryRun,
        preview,
      };
    }
    case 'vault_hosts_list': {
      const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
      return { kind: 'vault.summary', section: 'hosts', count: hosts.length };
    }
    case 'host_get':
      return parseHostArtifact(payload.host);
    default:
      return null;
  }
}
