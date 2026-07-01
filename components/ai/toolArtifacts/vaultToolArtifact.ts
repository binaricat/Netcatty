import { normalizeArtifactToolName } from './toolArtifactNames';
import { parseResultPayload } from './toolArtifactResultPayload';

export type VaultSummarySection = 'notes' | 'hosts' | 'snippets' | 'scripts';

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
      section: VaultSummarySection;
      count: number;
    }
  | {
      kind: 'vault.snippet';
      snippetId: string;
      label: string;
      package?: string;
    }
  | {
      kind: 'vault.script';
      scriptId: string;
      label: string;
      package?: string;
      language?: string;
    }
  | {
      kind: 'vault.snippet.deleted';
      snippetId: string;
    }
  | {
      kind: 'vault.script.deleted';
      scriptId: string;
    }
  | {
      kind: 'vault.snippet.run';
      snippetId: string;
      command?: string;
    }
  | {
      kind: 'vault.script.run';
      scriptId: string;
      runId: string;
      status?: string;
    }
  | {
      kind: 'vault.script.runs';
      count: number;
    }
  | {
      kind: 'vault.script.action';
      action: 'stop' | 'pause' | 'resume';
      runId: string;
    }
  | {
      kind: 'vault.script.reference';
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
  'snippets_list',
  'snippets_get',
  'snippets_create',
  'snippets_update',
  'snippets_delete',
  'snippets_run',
  'scripts_list',
  'scripts_get',
  'scripts_create',
  'scripts_update',
  'scripts_delete',
  'scripts_run',
  'scripts_reference',
  'scripts_runs_list',
  'scripts_run_stop',
  'scripts_run_pause',
  'scripts_run_resume',
  'scripts_targets_set',
]);

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

function parseSnippetArtifact(snippet: unknown): VaultToolArtifact | null {
  if (!snippet || typeof snippet !== 'object') return null;
  const record = snippet as Record<string, unknown>;
  const snippetId = readString(record.id);
  const label = readString(record.label);
  if (!snippetId || !label) return null;
  return {
    kind: 'vault.snippet',
    snippetId,
    label,
    package: readString(record.package),
  };
}

function parseScriptArtifact(script: unknown): VaultToolArtifact | null {
  if (!script || typeof script !== 'object') return null;
  const record = script as Record<string, unknown>;
  const scriptId = readString(record.id);
  const label = readString(record.label);
  if (!scriptId || !label) return null;
  return {
    kind: 'vault.script',
    scriptId,
    label,
    package: readString(record.package),
    language: readString(record.language),
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
  const normalized = normalizeArtifactToolName(toolName);
  return normalized ? VAULT_ARTIFACT_TOOL_NAMES.has(normalized) : false;
}

export function parseVaultToolArtifact(
  toolName: string,
  result: unknown,
): VaultToolArtifact | null {
  const normalizedToolName = normalizeArtifactToolName(toolName);
  if (!normalizedToolName || !VAULT_ARTIFACT_TOOL_NAMES.has(normalizedToolName)) return null;

  const payload = parseResultPayload(result);
  if (!payload) return null;

  if (payload.ok === false || payload.isError === true) {
    const message = readString(payload.error) ?? 'Operation failed.';
    return { kind: 'error', message };
  }

  switch (normalizedToolName) {
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
        sourceTool: normalizedToolName === 'vault_hosts_import' ? 'vault_hosts_import' : 'vault_hosts_create',
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
    case 'snippets_list': {
      const snippets = Array.isArray(payload.snippets) ? payload.snippets : [];
      return { kind: 'vault.summary', section: 'snippets', count: snippets.length };
    }
    case 'snippets_get':
    case 'snippets_create':
    case 'snippets_update':
      return parseSnippetArtifact(payload.snippet);
    case 'snippets_delete': {
      const snippetId = readString(payload.snippetId);
      if (!snippetId) return null;
      return { kind: 'vault.snippet.deleted', snippetId };
    }
    case 'snippets_run': {
      const snippetId = readString(payload.snippetId);
      if (!snippetId) return null;
      return {
        kind: 'vault.snippet.run',
        snippetId,
        command: readString(payload.command),
      };
    }
    case 'scripts_list': {
      const scripts = Array.isArray(payload.scripts) ? payload.scripts : [];
      return { kind: 'vault.summary', section: 'scripts', count: scripts.length };
    }
    case 'scripts_get':
    case 'scripts_create':
    case 'scripts_update':
    case 'scripts_targets_set':
      return parseScriptArtifact(payload.script);
    case 'scripts_delete': {
      const scriptId = readString(payload.scriptId);
      if (!scriptId) return null;
      return { kind: 'vault.script.deleted', scriptId };
    }
    case 'scripts_run': {
      const scriptId = readString(payload.snippetId) ?? readString(payload.scriptId);
      const runId = readString(payload.runId);
      if (!scriptId || !runId) return null;
      return {
        kind: 'vault.script.run',
        scriptId,
        runId,
        status: readString(payload.status),
      };
    }
    case 'scripts_reference':
      return { kind: 'vault.script.reference' };
    case 'scripts_runs_list': {
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      return { kind: 'vault.script.runs', count: runs.length };
    }
    case 'scripts_run_stop':
      return parseScriptRunAction(payload, 'stop');
    case 'scripts_run_pause':
      return parseScriptRunAction(payload, 'pause');
    case 'scripts_run_resume':
      return parseScriptRunAction(payload, 'resume');
    default:
      return null;
  }
}

function parseScriptRunAction(
  payload: Record<string, unknown>,
  action: 'stop' | 'pause' | 'resume',
): VaultToolArtifact | null {
  const runId = readString(payload.runId);
  if (!runId) return null;
  return { kind: 'vault.script.action', action, runId };
}
