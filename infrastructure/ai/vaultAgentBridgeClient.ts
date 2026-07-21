import type { GroupConfig, Host, Identity, KnownHost, ManagedSource, PortForwardingRule, ProxyProfile, Snippet, SSHKey, TerminalSettings, VaultNote } from '../../domain/models';
import type { RememberImportedKeyPassphraseResult } from '../../application/defaultKeyPassphrases';
import {
  normalizeVaultNotes,
  sanitizeNoteTitle,
  sanitizeVaultNote,
} from '../../domain/notes';
import { getScriptApiReference } from '../../domain/scriptApiReference.ts';
import {
  applyScriptTargetsPatch,
  applySnippetCreateToVault,
  applySnippetUpdateToVault,
  buildSnippetFromAgentDraft,
  applySnippetAgentPatch,
  deleteSnippetFromVault,
  filterScriptSnippets,
  serializeScriptForAgentGet,
  serializeScriptForAgentList,
  serializeSnippetForAgentGet,
  serializeSnippetForAgentList,
  setHostConnectScriptIds,
  summarizeConnectScriptsForHost,
} from '../../domain/snippetAgentOps.ts';
import { isScriptSnippet } from '../../domain/snippetScript.ts';
import { applySnippetVariables, parseSnippetVariables } from '../../domain/snippetVariables';
import { getNextVaultOrder } from '../../domain/vaultOrder';
import {
  runAutomationScript,
  stopScriptRun,
  pauseScriptRun,
  resumeScriptRun,
  waitForScriptRun,
} from '../../application/state/scriptAutomationCoordinator.ts';
import {
  applyVaultHostDelete,
  applyVaultHostCreates,
  applyVaultHostUpdate,
  buildVaultHostsFromDrafts,
  parseVaultHostDraftsInput,
} from '../../domain/vaultHostCreate';
import {
  applyVaultHostImport,
  detectVaultImportFormat,
  filterVaultImportKeyPassphrasesAgainstExisting,
  importVaultHostsFromText,
  mergeVaultImportIssues,
  resolveVaultImportKeyPassphraseConflicts,
  VAULT_IMPORT_FORMATS,
  type VaultImportFormat,
} from '../../domain/vaultImport';
import { resolveHostAuth } from '../../domain/sshAuth';
import { netcattyBridge } from '../services/netcattyBridge';
import {
  createPortForwardingRule,
  duplicatePortForwardingRule,
  hasPortForwardingConnectionChanged,
  updatePortForwardingRule,
  validatePortForwardingHost,
} from '../../domain/portForwardingAgentOps';
import { deleteGroup, upsertGroup } from '../../domain/vaultGroupAgentOps';

const SENSITIVE_HOST_KEYS = new Set([
  'password',
  'telnetPassword',
  'privateKey',
  'passphrase',
]);

/**
 * Reserved chatSessionId the TCP bridge forces onto every authenticated
 * external-MCP socket (see electron/bridges/mcpServerBridge.cjs and
 * electron/cli/externalMcpDiscoveryPath.cjs). A missing chatSessionId is NOT
 * a reliable "external MCP" signal — the stdio server always sends one, and
 * the bridge overwrites it with this value for external-token sockets — so
 * callers must compare against this exact constant instead.
 */
const EXTERNAL_MCP_CHAT_SESSION_ID = '__external_mcp__';

const VAULT_HOST_UPDATE_FIELDS = [
  'label',
  'name',
  'hostname',
  'host',
  'ip',
  'port',
  'username',
  'password',
  'savePassword',
  'keyPath',
  'keypath',
  'group',
  'tags',
  'notes',
  'protocol',
  'identityId',
  'jumpHostIds',
  'proxyProfileId',
  'startupCommand',
  'startupCommandRunMode',
  'environmentVariables',
  'moshEnabled',
  'moshServerPath',
  'etEnabled',
  'etPort',
  'serialConfig',
] as const;

export function sanitizeHostForAgent(host: Host): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(host)) {
    if (SENSITIVE_HOST_KEYS.has(key)) continue;
    if (key === 'proxyConfig' && value && typeof value === 'object' && !Array.isArray(value)) {
      const safeProxyConfig = { ...(value as Record<string, unknown>) };
      delete safeProxyConfig.password;
      sanitized[key] = safeProxyConfig;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function summarizeHostForList(host: Host) {
  return {
    id: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    protocol: host.protocol,
    group: host.group,
    tags: host.tags,
    os: host.os,
    createdAt: host.createdAt,
    connectScriptIds: host.connectScriptIds,
    loginScriptId: host.loginScriptId,
  };
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

function resolveVaultImportFormat(raw: unknown): VaultImportFormat | 'auto' | { error: string } {
  const format = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!format) return { error: 'format is required.' };
  if (format === 'auto') return 'auto';
  if ((VAULT_IMPORT_FORMATS as readonly string[]).includes(format)) {
    return format as VaultImportFormat;
  }
  return {
    error: `Unsupported format "${format}". Use csv, putty, mobaxterm, securecrt, ssh_config, or auto.`,
  };
}

export function sanitizePortForwardRuleForAgent(rule: PortForwardingRule): Record<string, unknown> {
  return {
    id: rule.id,
    label: rule.label,
    type: rule.type,
    localPort: rule.localPort,
    bindAddress: rule.bindAddress,
    remoteHost: rule.remoteHost,
    remotePort: rule.remotePort,
    hostId: rule.hostId,
    autoStart: rule.autoStart,
    status: rule.status,
    error: rule.error,
    createdAt: rule.createdAt,
    lastUsedAt: rule.lastUsedAt,
  };
}

function summarizeVaultNoteForList(note: VaultNote) {
  return {
    id: note.id,
    title: note.title,
    group: note.group,
    tags: note.tags,
    linkedHostIds: note.linkedHostIds,
    updatedAt: note.updatedAt,
    contentLength: note.content.length,
  };
}

function serializeVaultNoteForAgent(note: VaultNote) {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    group: note.group,
    tags: note.tags,
    linkedHostIds: note.linkedHostIds,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

const SAFE_GROUP_CONFIG_KEYS = [
  'path',
  'order',
  'username',
  'authMethod',
  'identityId',
  'port',
  'protocol',
  'deviceType',
  'agentForwarding',
  'proxyProfileId',
  'hostChain',
  'startupCommandRunMode',
  'loginScriptId',
  'legacyAlgorithms',
  'skipEcdsaHostKey',
  'algorithms',
  'charset',
  'moshEnabled',
  'moshServerPath',
  'etEnabled',
  'etPort',
  'telnetEnabled',
  'telnetPort',
  'telnetIdentityId',
  'telnetUsername',
  'theme',
  'themeOverride',
  'fontFamily',
  'fontFamilyOverride',
  'fontSize',
  'fontSizeOverride',
  'fontWeight',
  'fontWeightOverride',
  'backspaceBehavior',
] as const satisfies readonly (keyof GroupConfig)[];

function sanitizeGroupConfigForAgent(config: GroupConfig): Record<string, unknown> {
  const safe = Object.fromEntries(
    SAFE_GROUP_CONFIG_KEYS
      .filter((key) => Object.hasOwn(config, key))
      .map((key) => [key, config[key]]),
  );
  return {
    ...safe,
    ...(config.proxyConfig ? {
      proxyConfig: {
        type: config.proxyConfig.type,
        host: config.proxyConfig.host,
        port: config.proxyConfig.port,
        identityId: config.proxyConfig.identityId,
        username: config.proxyConfig.username,
      },
    } : {}),
  };
}

function parseSnippetVariableValues(
  raw: unknown,
): Record<string, string> | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]),
    );
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]),
      );
    }
    return { error: 'variables must be a JSON object string.' };
  } catch {
    return { error: 'variables must be a JSON object string.' };
  }
}

function parseOptionalStringArray(
  value: unknown,
  fieldName: string,
): string[] | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') {
    return { error: `${fieldName} must be a string or array.` };
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return { error: `${fieldName} must be a JSON array.` };
      }
      return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    } catch {
      return { error: `${fieldName} must be valid JSON array.` };
    }
  }
  return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function snippetDraftFromParams(params: Record<string, unknown>) {
  const command = params.command ?? params.content;
  return {
    label: params.label,
    command,
    kind: params.kind,
    tags: params.tags,
    targets: params.targets,
    targetsAllHosts: params.targetsAllHosts,
    package: params.package,
    shortkey: params.shortkey,
    noAutoRun: params.noAutoRun,
    multiLineRunMode: params.multiLineRunMode,
    language: params.language,
    description: params.description,
    trigger: params.trigger,
    triggerPattern: params.triggerPattern,
  };
}

async function executeSnippetOrScriptRun(
  snippet: Snippet,
  sessionId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (isScriptSnippet(snippet)) {
    const wait = parseOptionalBoolean(params.wait) ?? false;
    try {
      const { runId } = await runAutomationScript({
        snippet,
        sessionId,
      });
      if (!wait) {
        return { ok: true, sessionId, snippetId: snippet.id, runId, kind: 'script' };
      }
      const run = await waitForScriptRun(runId);
      return {
        ok: true,
        sessionId,
        snippetId: snippet.id,
        runId,
        kind: 'script',
        status: run.status,
        error: run.error,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  let variableValues: Record<string, string> = {};
  const parsedVariables = parseSnippetVariableValues(params.variables);
  if ('error' in parsedVariables) {
    return { ok: false, error: parsedVariables.error };
  }
  variableValues = parsedVariables;

  const defs = parseSnippetVariables(snippet.command);
  for (const def of defs) {
    if (variableValues[def.name] === undefined && def.defaultValue !== undefined) {
      variableValues[def.name] = def.defaultValue;
    }
  }
  for (const def of defs) {
    if ((variableValues[def.name] ?? '').trim() === '' && def.defaultValue === undefined) {
      return { ok: false, error: `Missing snippet variable "${def.name}".` };
    }
  }

  const command = applySnippetVariables(snippet.command, variableValues);
  const bridge = netcattyBridge.get();
  if (!bridge?.aiExec) {
    return { ok: false, error: 'Terminal execution bridge is unavailable.' };
  }
  const chatSessionId = typeof params.chatSessionId === 'string' ? params.chatSessionId : undefined;
  const result = await bridge.aiExec(sessionId, command, chatSessionId);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    return { ok: false, error: (result as { error?: string }).error || 'Snippet execution failed.' };
  }
  return { ok: true, sessionId, snippetId: snippet.id, command, kind: 'snippet', result };
}

export interface VaultAgentApiDeps {
  getHosts: () => Host[];
  getNotes: () => VaultNote[];
  getCustomGroups: () => string[];
  getGroupConfigs: () => GroupConfig[];
  getPortForwardingRules: () => PortForwardingRule[];
  getManagedSources: () => ManagedSource[];
  snippets: Snippet[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts: KnownHost[];
  proxyProfiles: ProxyProfile[];
  terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>;
  resolveEffectiveHost: (host: Host) => Host;
  updateHostNotes: (hostId: string, notes: string) => void;
  updateCustomGroups: (groups: string[]) => void;
  updateGroupConfigs: (configs: GroupConfig[]) => void;
  updatePortForwardingRules: (rules: PortForwardingRule[]) => void;
  updateManagedSources: (sources: ManagedSource[]) => void;
  updateHosts: (hosts: Host[]) => void;
  saveKeyPassphrase: (keyPath: string, passphrase: string) => Promise<void>;
  saveImportedKeyPassphrase?: (
    keyPath: string,
    passphrase: string,
  ) => Promise<RememberImportedKeyPassphraseResult>;
  resolveKeyPassphraseAliases: (keyPath: string) => Promise<string[]>;
  readKeyPassphrases: (keyPath: string) => Promise<{
    values: string[];
    unreadable: boolean;
  }>;
  removeKeyPassphrases: (keyPaths: string[]) => Promise<void> | void;
  updateNotes: (notes: VaultNote[]) => void;
  updateSnippets: (snippets: Snippet[]) => void;
  startTunnel: (
    rule: PortForwardingRule,
    host: Host,
    hosts: Host[],
    keys: SSHKey[],
    identities: Identity[],
    onStatusChange?: (status: PortForwardingRule['status'], error?: string) => void,
    enableReconnect?: boolean,
    terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>,
    knownHosts?: KnownHost[],
  ) => Promise<{ success: boolean; error?: string }>;
  stopTunnel: (
    ruleId: string,
    onStatusChange?: (status: PortForwardingRule['status']) => void,
  ) => Promise<{ success: boolean; error?: string }>;
  stopRuleTunnels: (ruleId: string) => Promise<{ success: boolean; error?: string }>;
  /**
   * Open a vault host as a terminal tab (same path as tray / host list click).
   * Must return the new sessionId so MCP can target terminal tools. `isExternalMcpCall`
   * is true only when the request has no chatSessionId — i.e. it came from an actual
   * external MCP client rather than the in-app Catty AI chat — and gates the "silent
   * sessions" setting so the in-app chat's host_open still opens a visible tab.
   */
  openHost?: (host: Host, isExternalMcpCall: boolean) => {
    ok: true;
    sessionId: string;
    host: Host;
  } | {
    ok: false;
    error: string;
  };
  closeSession?: (sessionId: string) => {
    ok: true;
  } | {
    ok: false;
    error: string;
  };
}

function resolveEffectiveHostKeyPath(host: Host, deps: VaultAgentApiDeps): string | undefined {
  const effectiveHost = deps.resolveEffectiveHost(host);
  const resolvedAuth = resolveHostAuth({
    host: effectiveHost,
    keys: deps.keys,
    identities: deps.identities,
  });
  return resolvedAuth.identityFilePath ?? effectiveHost.identityFilePaths?.[0];
}

async function registerOpenedSessionInMcpScope(
  sessionId: string,
  host: Host,
  chatSessionId?: string,
): Promise<void> {
  let bridge: ReturnType<typeof netcattyBridge.get> | undefined;
  try {
    bridge = netcattyBridge.get();
  } catch {
    // Node unit tests / non-renderer contexts have no window.
    return;
  }
  if (!bridge?.aiMcpMergeSessions) return;

  const protocol = host.etEnabled
    ? 'et'
    : host.moshEnabled
      ? 'mosh'
      : (host.protocol || 'ssh');
  const sessionInfo = {
    sessionId,
    hostId: host.id,
    hostname: host.hostname || '',
    label: host.label || host.hostname || sessionId,
    os: host.os || '',
    username: host.username || '',
    protocol,
    deviceType: host.deviceType || '',
    connected: false,
    hostChain: [],
    activePortForwards: [],
  };

  const scopes = new Set<string>();
  if (chatSessionId && chatSessionId.trim()) {
    scopes.add(chatSessionId.trim());
  }
  // Always merge into the reserved external MCP scope when that surface is
  // active; External MCP agents can then terminal_execute without waiting for
  // the next React session-sync tick.
  scopes.add(EXTERNAL_MCP_CHAT_SESSION_ID);

  await Promise.all(
    [...scopes].map(async (scopeId) => {
      try {
        await bridge.aiMcpMergeSessions?.([sessionInfo], scopeId);
      } catch {
        // Scope merge is best-effort; open itself already succeeded.
      }
    }),
  );
}

export async function handleVaultAgentOp(
  op: string,
  params: Record<string, unknown>,
  deps: VaultAgentApiDeps,
): Promise<Record<string, unknown>> {
  switch (op) {
    case 'session.close': {
      const sessionId = String(params.sessionId || '').trim();
      if (!sessionId) return { ok: false, error: 'sessionId is required.' };
      if (typeof deps.closeSession !== 'function') {
        return { ok: false, error: 'Session close is not available in this window.' };
      }
      const closed = deps.closeSession(sessionId);
      if (!closed.ok) return closed;
      return { ok: true, sessionId, status: 'closed' };
    }
    case 'host.get': {
      const hostId = String(params.hostId || '');
      const host = deps.getHosts().find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      return { ok: true, host: sanitizeHostForAgent(deps.resolveEffectiveHost(host)) };
    }
    case 'host.list': {
      return {
        ok: true,
        hosts: deps.getHosts().map((host) => summarizeHostForList(deps.resolveEffectiveHost(host))),
      };
    }
    case 'host.open': {
      const hostId = String(params.hostId || '').trim();
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const host = deps.getHosts().find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      if (typeof deps.openHost !== 'function') {
        return { ok: false, error: 'Host open is not available in this window.' };
      }

      const chatSessionId = typeof params.chatSessionId === 'string'
        ? params.chatSessionId
        : undefined;
      // The TCP bridge forces every authenticated external-MCP socket's
      // chatSessionId to this reserved value, so a missing chatSessionId is
      // not a reliable signal — compare against the constant instead.
      const isExternalMcpCall = chatSessionId === EXTERNAL_MCP_CHAT_SESSION_ID;
      const effectiveHost = deps.resolveEffectiveHost(host);
      const opened = deps.openHost(effectiveHost, isExternalMcpCall);
      if (!opened.ok) {
        return { ok: false, error: opened.error };
      }

      await registerOpenedSessionInMcpScope(opened.sessionId, effectiveHost, chatSessionId);

      const protocol = effectiveHost.etEnabled
        ? 'et'
        : effectiveHost.moshEnabled
          ? 'mosh'
          : (effectiveHost.protocol || 'ssh');

      return {
        ok: true,
        sessionId: opened.sessionId,
        hostId: effectiveHost.id,
        status: 'connecting',
        protocol,
        host: summarizeHostForList(effectiveHost),
        message:
          'Terminal tab opened. Connection may still be establishing; use get_environment or wait briefly before terminal_execute if the session is not ready yet.',
      };
    }
    case 'hosts.create': {
      const parsedDrafts = parseVaultHostDraftsInput(params.hosts);
      if (!parsedDrafts.ok) return { ok: false, error: parsedDrafts.error };

      const dryRun = parseOptionalBoolean(params.dryRun) ?? false;
      const skipDuplicates = parseOptionalBoolean(params.skipDuplicates) ?? true;
      const {
        hosts: builtHosts,
        issues: buildIssues,
        keyPassphrases,
      } = buildVaultHostsFromDrafts(parsedDrafts.drafts);

      if (builtHosts.length === 0) {
        return {
          ok: false,
          error: buildIssues[0]?.error || 'No valid hosts to create.',
          issues: buildIssues,
        };
      }

      const previewHosts = builtHosts.map((host) => sanitizeHostForAgent(host));

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          parsedCount: parsedDrafts.drafts.length,
          validCount: builtHosts.length,
          issues: buildIssues,
          previewHosts,
        };
      }

      const merged = applyVaultHostCreates(
        deps.getHosts(),
        deps.getCustomGroups(),
        builtHosts,
        { skipDuplicates },
      );

      if (merged.addedCount === 0) {
        return {
          ok: false,
          error: 'No new hosts were added (all duplicates or invalid).',
          issues: buildIssues,
          skippedExistingCount: merged.skippedExistingCount,
          previewHosts,
        };
      }

      const addedHostIds = new Set(merged.addedHosts.map((host) => host.id));
      for (const entry of keyPassphrases) {
        if (addedHostIds.has(entry.hostId)) {
          await deps.saveKeyPassphrase(entry.keyPath, entry.passphrase);
        }
      }

      deps.updateHosts(merged.hosts);
      deps.updateCustomGroups(merged.customGroups);

      return {
        ok: true,
        dryRun: false,
        parsedCount: parsedDrafts.drafts.length,
        validCount: builtHosts.length,
        addedCount: merged.addedCount,
        skippedExistingCount: merged.skippedExistingCount,
        issues: buildIssues,
        previewHosts: merged.addedHosts.map((host) => sanitizeHostForAgent(host)),
      };
    }
    case 'host.update': {
      const hostId = String(params.hostId || '').trim();
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const currentHosts = deps.getHosts();
      const currentHost = currentHosts.find((host) => host.id === hostId);
      if (!currentHost) return { ok: false, error: `Host "${hostId}" was not found.` };
      const passphraseProvided = Object.prototype.hasOwnProperty.call(params, 'passphrase');
      if (passphraseProvided && typeof params.passphrase !== 'string') {
        return { ok: false, error: 'passphrase must be a string.' };
      }
      const passphrase = typeof params.passphrase === 'string' ? params.passphrase : undefined;
      const effectiveKeyPathInput = params.keyPath ?? params.keypath;
      const clearedLocalKeyPath = passphrase === ''
        && typeof effectiveKeyPathInput === 'string'
        && !effectiveKeyPathInput.trim()
        ? currentHost.identityFilePaths?.find((path) => path.trim())?.trim()
        : undefined;
      const hasHostPatch = VAULT_HOST_UPDATE_FIELDS.some((field) => (
        Object.prototype.hasOwnProperty.call(params, field)
      ));
      if (!hasHostPatch && !passphraseProvided) {
        return { ok: false, error: 'At least one host field is required.' };
      }

      let updatedHost = currentHost;
      let updatedHosts: Host[] | undefined;
      let updatedCustomGroups: string[] | undefined;
      if (hasHostPatch) {
        const updated = applyVaultHostUpdate(
          currentHosts,
          deps.getCustomGroups(),
          hostId,
          params,
          {
            resolveEffectiveHost: deps.resolveEffectiveHost,
            groupConfigs: deps.getGroupConfigs(),
            managedSources: deps.getManagedSources(),
            identities: deps.identities,
            proxyProfiles: deps.proxyProfiles,
          },
        );
        if (!updated.ok) return updated;
        updatedHost = updated.updatedHost;
        updatedHosts = updated.hosts;
        updatedCustomGroups = updated.customGroups;
      }

      if (passphraseProvided) {
        let keyPath = clearedLocalKeyPath ?? resolveEffectiveHostKeyPath(updatedHost, deps);
        if (!keyPath && passphrase === '') {
          keyPath = resolveEffectiveHostKeyPath(currentHost, deps);
        }
        if (!keyPath) {
          return { ok: false, error: 'A keyPath is required when passphrase is provided.' };
        }
        if (passphrase) {
          await deps.saveKeyPassphrase(keyPath, passphrase);
        } else {
          await deps.removeKeyPassphrases([keyPath]);
        }
      }

      if (updatedHosts && updatedCustomGroups) {
        deps.updateHosts(updatedHosts);
        deps.updateCustomGroups(updatedCustomGroups);
      }

      return {
        ok: true,
        hostId,
        host: sanitizeHostForAgent(updatedHost),
      };
    }
    case 'host.delete': {
      const hostId = String(params.hostId || '').trim();
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const deleted = applyVaultHostDelete(
        deps.getHosts(),
        hostId,
        deps.resolveEffectiveHost,
        deps.getGroupConfigs(),
      );
      if (!deleted.ok) return deleted;

      deps.updateHosts(deleted.hosts);
      return {
        ok: true,
        hostId,
        deletedHost: sanitizeHostForAgent(deleted.deletedHost),
      };
    }
    case 'host.import': {
      const text = typeof params.text === 'string' ? params.text : '';
      if (!text.trim()) return { ok: false, error: 'text is required.' };

      const formatParam = resolveVaultImportFormat(params.format);
      if (typeof formatParam === 'object' && 'error' in formatParam) {
        return { ok: false, error: formatParam.error };
      }

      let resolvedFormat: VaultImportFormat;
      if (formatParam === 'auto') {
        const detected = detectVaultImportFormat(text);
        if (!detected) {
          return {
            ok: false,
            error: 'Could not detect import format. Specify csv, putty, mobaxterm, securecrt, or ssh_config.',
          };
        }
        resolvedFormat = detected;
      } else {
        resolvedFormat = formatParam;
      }

      const dryRun = parseOptionalBoolean(params.dryRun) ?? false;
      const skipDuplicates = parseOptionalBoolean(params.skipDuplicates) ?? true;
      const fileName = typeof params.fileName === 'string' && params.fileName.trim()
        ? params.fileName.trim()
        : undefined;

      const importResult = importVaultHostsFromText(resolvedFormat, text, { fileName });
      const previewHosts = importResult.hosts.map((host) => sanitizeHostForAgent(host));
      const merged = applyVaultHostImport(
        deps.getHosts(),
        deps.getCustomGroups(),
        importResult,
        { skipDuplicates },
      );
      const addedHostIds = new Set(merged.addedHosts.map((host) => host.id));
      const addedHostKeyPaths = new Map(merged.addedHosts.flatMap((host) => {
        const keyPath = host.identityFilePaths?.find((path) => path.trim())?.trim();
        return keyPath ? [[host.id, keyPath] as const] : [];
      }));
      const resolved = await resolveVaultImportKeyPassphraseConflicts(
        importResult.keyPassphraseCandidates ?? importResult.keyPassphrases ?? [],
        deps.resolveKeyPassphraseAliases,
        addedHostIds,
        addedHostKeyPaths,
      );
      const checked = await filterVaultImportKeyPassphrasesAgainstExisting(
        resolved.keyPassphrases,
        deps.readKeyPassphrases,
      );
      const credentialIssues = mergeVaultImportIssues(resolved.issues, checked.issues);

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          format: resolvedFormat,
          stats: importResult.stats,
          issues: mergeVaultImportIssues(importResult.issues, credentialIssues),
          groups: importResult.groups,
          previewHosts,
        };
      }

      if (merged.addedCount === 0 && importResult.stats.parsed === 0) {
        return {
          ok: false,
          error: importResult.issues[0]?.message || 'No hosts were imported.',
          format: resolvedFormat,
          stats: importResult.stats,
          issues: importResult.issues,
        };
      }

      deps.updateHosts(merged.hosts);
      deps.updateCustomGroups(merged.customGroups);
      const saveIssues = [...credentialIssues];
      for (const entry of checked.keyPassphrases) {
        try {
          let saved: RememberImportedKeyPassphraseResult = 'saved';
          if (deps.saveImportedKeyPassphrase) {
            saved = await deps.saveImportedKeyPassphrase(entry.keyPath, entry.passphrase);
          } else {
            await deps.saveKeyPassphrase(entry.keyPath, entry.passphrase);
          }
          if (saved === 'conflict') {
            saveIssues.push({
              level: 'warning',
              message: `CSV passphrase conflicts with an existing saved passphrase for KeyPath "${entry.keyPath}"; the existing passphrase was kept.`,
            });
          } else if (saved === 'unreadable') {
            saveIssues.push({
              level: 'warning',
              message: `Could not verify the existing saved passphrase for KeyPath "${entry.keyPath}"; the imported passphrase was not saved.`,
            });
          }
        } catch {
          saveIssues.push({
            level: 'warning',
            message: `Could not save the passphrase for KeyPath "${entry.keyPath}".`,
          });
        }
      }

      return {
        ok: true,
        dryRun: false,
        format: resolvedFormat,
        stats: importResult.stats,
        issues: mergeVaultImportIssues(importResult.issues, saveIssues),
        addedCount: merged.addedCount,
        skippedExistingCount: merged.skippedExistingCount,
        previewHosts: previewHosts.slice(0, 20),
      };
    }
    case 'host.notes.get': {
      const hostId = String(params.hostId || '');
      const host = deps.getHosts().find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      return { ok: true, hostId, notes: host.notes || '' };
    }
    case 'host.notes.set': {
      const hostId = String(params.hostId || '');
      const notes = typeof params.notes === 'string' ? params.notes : '';
      const host = deps.getHosts().find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      deps.updateHostNotes(hostId, notes);
      return { ok: true, hostId };
    }
    case 'note.list': {
      return {
        ok: true,
        notes: deps.getNotes().map(summarizeVaultNoteForList),
      };
    }
    case 'note.get': {
      const noteId = String(params.noteId || '');
      const note = deps.getNotes().find((entry) => entry.id === noteId);
      if (!note) return { ok: false, error: `Vault note "${noteId}" was not found.` };
      return { ok: true, note: serializeVaultNoteForAgent(note) };
    }
    case 'note.create': {
      const title = sanitizeNoteTitle(params.title);
      if (!title) return { ok: false, error: 'title is required.' };
      const content = typeof params.content === 'string' ? params.content : '';
      const linkedHostIds = parseOptionalStringArray(params.linkedHostIds, 'linkedHostIds');
      if (linkedHostIds && 'error' in linkedHostIds) return { ok: false, error: linkedHostIds.error };
      const tags = parseOptionalStringArray(params.tags, 'tags');
      if (tags && 'error' in tags) return { ok: false, error: tags.error };
      const note = sanitizeVaultNote({
        title,
        content,
        group: typeof params.group === 'string' && params.group.trim() ? params.group.trim() : undefined,
        linkedHostIds,
        tags,
        order: getNextVaultOrder(deps.getNotes()),
      });
      const nextNotes = normalizeVaultNotes([...deps.getNotes(), note]);
      deps.updateNotes(nextNotes);
      return { ok: true, note: serializeVaultNoteForAgent(note) };
    }
    case 'note.update': {
      const noteId = String(params.noteId || '');
      const existing = deps.getNotes().find((entry) => entry.id === noteId);
      if (!existing) return { ok: false, error: `Vault note "${noteId}" was not found.` };
      const linkedHostIds = parseOptionalStringArray(params.linkedHostIds, 'linkedHostIds');
      if (linkedHostIds && 'error' in linkedHostIds) return { ok: false, error: linkedHostIds.error };
      const tags = parseOptionalStringArray(params.tags, 'tags');
      if (tags && 'error' in tags) return { ok: false, error: tags.error };
      const note = sanitizeVaultNote({
        ...existing,
        title: params.title !== undefined ? sanitizeNoteTitle(params.title) : existing.title,
        content: typeof params.content === 'string' ? params.content : existing.content,
        group: params.group !== undefined
          ? (typeof params.group === 'string' && params.group.trim() ? params.group.trim() : undefined)
          : existing.group,
        linkedHostIds: linkedHostIds ?? existing.linkedHostIds,
        tags: tags ?? existing.tags,
        updatedAt: Date.now(),
      });
      if (!note.title) return { ok: false, error: 'title cannot be empty.' };
      const nextNotes = normalizeVaultNotes(
        deps.getNotes().map((entry) => (entry.id === noteId ? note : entry)),
      );
      deps.updateNotes(nextNotes);
      return { ok: true, note: serializeVaultNoteForAgent(note) };
    }
    case 'note.delete': {
      const noteId = String(params.noteId || '');
      if (!deps.getNotes().some((note) => note.id === noteId)) {
        return { ok: false, error: `Vault note "${noteId}" was not found.` };
      }
      deps.updateNotes(normalizeVaultNotes(deps.getNotes().filter((note) => note.id !== noteId)));
      return { ok: true, noteId };
    }
    case 'identity.list': {
      return {
        ok: true,
        identities: deps.identities.map((identity) => ({
          id: identity.id,
          label: identity.label,
          username: identity.username,
          authMethod: identity.authMethod,
          keyId: identity.keyId,
        })),
      };
    }
    case 'proxyProfile.list': {
      return {
        ok: true,
        proxyProfiles: deps.proxyProfiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          type: profile.config.type,
          host: profile.config.host,
          port: profile.config.port,
        })),
      };
    }
    case 'group.list': {
      const configs = new Map(deps.getGroupConfigs().map((config) => [config.path, config]));
      return {
        ok: true,
        groups: deps.getCustomGroups().map((path) => {
          const config = configs.get(path);
          if (!config) return { path };
          return { path, defaults: sanitizeGroupConfigForAgent(config) };
        }),
      };
    }
    case 'group.create':
    case 'group.update': {
      const result = upsertGroup({
        groups: deps.getCustomGroups(),
        configs: deps.getGroupConfigs(),
        hosts: deps.getHosts(),
        managedSources: deps.getManagedSources(),
      }, params.path, params.defaults, deps.identities, deps.proxyProfiles, {
        create: op === 'group.create',
        newPath: params.newPath,
      });
      if (!result.ok) return result;
      deps.updateCustomGroups(result.state.groups);
      deps.updateGroupConfigs(result.state.configs);
      deps.updateHosts(result.state.hosts);
      deps.updateManagedSources(result.state.managedSources);
      return { ok: true, group: sanitizeGroupConfigForAgent(result.config ?? { path: String(params.path) }) };
    }
    case 'group.delete': {
      const deleteHosts = parseOptionalBoolean(params.deleteHosts);
      if (params.deleteHosts !== undefined && deleteHosts === undefined) {
        return { ok: false, error: 'deleteHosts must be true or false.' };
      }
      const result = deleteGroup({
        groups: deps.getCustomGroups(), configs: deps.getGroupConfigs(), hosts: deps.getHosts(),
        managedSources: deps.getManagedSources(),
      }, params.path, deleteHosts ?? false);
      if (!result.ok) return result;
      deps.updateCustomGroups(result.state.groups);
      deps.updateGroupConfigs(result.state.configs);
      deps.updateHosts(result.state.hosts);
      return { ok: true, path: String(params.path), deletedHosts: deleteHosts ?? false };
    }
    case 'snippets.list': {
      return {
        ok: true,
        snippets: deps.snippets.map(serializeSnippetForAgentList),
      };
    }
    case 'snippets.get': {
      const snippetId = String(params.snippetId || '');
      const snippet = deps.snippets.find((entry) => entry.id === snippetId);
      if (!snippet) return { ok: false, error: `Snippet "${snippetId}" was not found.` };
      return { ok: true, snippet: serializeSnippetForAgentGet(snippet) };
    }
    case 'snippets.create': {
      const built = buildSnippetFromAgentDraft(snippetDraftFromParams(params), deps.snippets);
      if (!built.ok) return { ok: false, error: built.error };
      const merged = applySnippetCreateToVault(deps.snippets, deps.getHosts(), built.snippet);
      deps.updateSnippets(merged.snippets);
      deps.updateHosts(merged.hosts);
      return { ok: true, snippet: serializeSnippetForAgentGet(built.snippet) };
    }
    case 'snippets.update': {
      const snippetId = String(params.snippetId || '');
      const existing = deps.snippets.find((entry) => entry.id === snippetId);
      if (!existing) return { ok: false, error: `Snippet "${snippetId}" was not found.` };
      const patched = applySnippetAgentPatch(existing, snippetDraftFromParams(params));
      if (!patched.ok) return { ok: false, error: patched.error };
      const merged = applySnippetUpdateToVault(
        deps.snippets,
        deps.getHosts(),
        patched.snippet,
        existing,
        patched.prevTargetIds,
      );
      deps.updateSnippets(merged.snippets);
      deps.updateHosts(merged.hosts);
      return { ok: true, snippet: serializeSnippetForAgentGet(patched.snippet) };
    }
    case 'snippets.delete': {
      const snippetId = String(params.snippetId || '');
      const removed = deleteSnippetFromVault(deps.snippets, deps.getHosts(), snippetId);
      if ('error' in removed) return { ok: false, error: removed.error };
      deps.updateSnippets(removed.snippets);
      deps.updateHosts(removed.hosts);
      return { ok: true, snippetId };
    }
    case 'snippets.run': {
      const snippetId = String(params.snippetId || '');
      const sessionId = String(params.sessionId || '');
      const snippet = deps.snippets.find((entry) => entry.id === snippetId);
      if (!snippet) return { ok: false, error: `Snippet "${snippetId}" was not found.` };
      if (!sessionId) return { ok: false, error: 'sessionId is required.' };
      return executeSnippetOrScriptRun(snippet, sessionId, params);
    }
    case 'scripts.list': {
      return {
        ok: true,
        scripts: filterScriptSnippets(deps.snippets).map(serializeScriptForAgentList),
      };
    }
    case 'scripts.get': {
      const scriptId = String(params.scriptId || params.snippetId || '');
      const script = deps.snippets.find((entry) => entry.id === scriptId && isScriptSnippet(entry));
      if (!script) return { ok: false, error: `Script "${scriptId}" was not found.` };
      return { ok: true, script: serializeScriptForAgentGet(script) };
    }
    case 'scripts.create': {
      const built = buildSnippetFromAgentDraft(
        snippetDraftFromParams(params),
        deps.snippets,
        { forceKind: 'script' },
      );
      if (!built.ok) return { ok: false, error: built.error };
      const merged = applySnippetCreateToVault(deps.snippets, deps.getHosts(), built.snippet);
      deps.updateSnippets(merged.snippets);
      deps.updateHosts(merged.hosts);
      return { ok: true, script: serializeScriptForAgentGet(built.snippet) };
    }
    case 'scripts.update': {
      const scriptId = String(params.scriptId || params.snippetId || '');
      const existing = deps.snippets.find((entry) => entry.id === scriptId);
      if (!existing || !isScriptSnippet(existing)) {
        return { ok: false, error: `Script "${scriptId}" was not found.` };
      }
      const patched = applySnippetAgentPatch(existing, snippetDraftFromParams(params), { forceKind: 'script' });
      if (!patched.ok) return { ok: false, error: patched.error };
      const merged = applySnippetUpdateToVault(
        deps.snippets,
        deps.getHosts(),
        patched.snippet,
        existing,
        patched.prevTargetIds,
      );
      deps.updateSnippets(merged.snippets);
      deps.updateHosts(merged.hosts);
      return { ok: true, script: serializeScriptForAgentGet(patched.snippet) };
    }
    case 'scripts.delete': {
      const scriptId = String(params.scriptId || params.snippetId || '');
      const existing = deps.snippets.find((entry) => entry.id === scriptId);
      if (!existing || !isScriptSnippet(existing)) {
        return { ok: false, error: `Script "${scriptId}" was not found.` };
      }
      const removed = deleteSnippetFromVault(deps.snippets, deps.getHosts(), scriptId);
      if ('error' in removed) return { ok: false, error: removed.error };
      deps.updateSnippets(removed.snippets);
      deps.updateHosts(removed.hosts);
      return { ok: true, scriptId };
    }
    case 'scripts.run': {
      const scriptId = String(params.scriptId || params.snippetId || '');
      const sessionId = String(params.sessionId || '');
      const script = deps.snippets.find((entry) => entry.id === scriptId && isScriptSnippet(entry));
      if (!script) return { ok: false, error: `Script "${scriptId}" was not found.` };
      if (!sessionId) return { ok: false, error: 'sessionId is required.' };
      return executeSnippetOrScriptRun(script, sessionId, params);
    }
    case 'scripts.reference': {
      return { ok: true, reference: getScriptApiReference() };
    }
    case 'scripts.runs.list': {
      const bridge = netcattyBridge.get();
      if (!bridge?.scriptGetRuns) {
        return { ok: false, error: 'Script runs bridge is unavailable.' };
      }
      const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : undefined;
      const runs = await bridge.scriptGetRuns(sessionId);
      return { ok: true, runs };
    }
    case 'scripts.run.stop': {
      const runId = String(params.runId || '');
      if (!runId) return { ok: false, error: 'runId is required.' };
      const result = await stopScriptRun(runId);
      if (!result.ok) return { ok: false, error: `Script run "${runId}" was not found or could not be stopped.` };
      return { ok: true, runId };
    }
    case 'scripts.run.pause': {
      const runId = String(params.runId || '');
      if (!runId) return { ok: false, error: 'runId is required.' };
      const result = await pauseScriptRun(runId);
      if (!result.ok) return { ok: false, error: `Script run "${runId}" was not found or could not be paused.` };
      return { ok: true, runId };
    }
    case 'scripts.run.resume': {
      const runId = String(params.runId || '');
      if (!runId) return { ok: false, error: 'runId is required.' };
      const result = await resumeScriptRun(runId);
      if (!result.ok) return { ok: false, error: `Script run "${runId}" was not found or could not be resumed.` };
      return { ok: true, runId };
    }
    case 'scripts.targets.set': {
      const scriptId = String(params.scriptId || params.snippetId || '');
      const existing = deps.snippets.find((entry) => entry.id === scriptId && isScriptSnippet(entry));
      if (!existing) return { ok: false, error: `Script "${scriptId}" was not found.` };
      const patched = applyScriptTargetsPatch(existing, {
        targets: params.targets,
        targetsAllHosts: params.targetsAllHosts,
      });
      if (!patched.ok) return { ok: false, error: patched.error };
      const merged = applySnippetUpdateToVault(
        deps.snippets,
        deps.getHosts(),
        patched.snippet,
        existing,
        patched.prevTargetIds,
      );
      deps.updateSnippets(merged.snippets);
      deps.updateHosts(merged.hosts);
      return { ok: true, script: serializeScriptForAgentGet(patched.snippet) };
    }
    case 'host.connectScripts.list': {
      const hostId = String(params.hostId || '');
      const host = deps.getHosts().find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      return {
        ok: true,
        ...summarizeConnectScriptsForHost(host, deps.snippets),
      };
    }
    case 'host.connectScripts.set': {
      const hostId = String(params.hostId || '');
      const host = deps.getHosts().find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      const scriptIds = parseOptionalStringArray(params.scriptIds, 'scriptIds');
      if (scriptIds && 'error' in scriptIds) return { ok: false, error: scriptIds.error };
      if (!scriptIds) return { ok: false, error: 'scriptIds is required.' };
      const nextHost = setHostConnectScriptIds(host, scriptIds, deps.snippets);
      if (!nextHost.ok) return { ok: false, error: nextHost.error };
      const nextHosts = deps.getHosts().map((entry) => (
        entry.id === hostId ? nextHost.host : entry
      ));
      deps.updateHosts(nextHosts);
      return {
        ok: true,
        hostId,
        connectScriptIds: nextHost.host.connectScriptIds ?? [],
      };
    }
    case 'portforward.rules.list': {
      return {
        ok: true,
        rules: deps.getPortForwardingRules().map(sanitizePortForwardRuleForAgent),
      };
    }
    case 'portforward.rules.create': {
      const effectiveHosts = deps.getHosts().map((host) => deps.resolveEffectiveHost(host));
      const result = createPortForwardingRule(deps.getPortForwardingRules(), effectiveHosts, params, {
        id: crypto.randomUUID(), now: Date.now(),
      });
      if (!result.ok) return result;
      deps.updatePortForwardingRules(result.value.rules);
      return { ok: true, rule: sanitizePortForwardRuleForAgent(result.value.rule) };
    }
    case 'portforward.rules.update': {
      const ruleId = String(params.ruleId || '');
      const currentRules = deps.getPortForwardingRules();
      const existingRule = currentRules.find((entry) => entry.id === ruleId);
      const effectiveHosts = deps.getHosts().map((host) => deps.resolveEffectiveHost(host));
      let result = updatePortForwardingRule(currentRules, effectiveHosts, ruleId, params);
      if (!result.ok) return result;
      if (
        existingRule
        && hasPortForwardingConnectionChanged(existingRule, result.value.rule)
      ) {
        const stopped = await deps.stopRuleTunnels(ruleId);
        if (!stopped.success) {
          return { ok: false, error: stopped.error || 'Failed to stop port forwarding tunnel.' };
        }
        const latestHosts = deps.getHosts().map((host) => deps.resolveEffectiveHost(host));
        result = updatePortForwardingRule(
          deps.getPortForwardingRules(),
          latestHosts,
          ruleId,
          params,
        );
        if (!result.ok) return result;
        const stoppedRule = {
          ...result.value.rule,
          status: 'inactive' as const,
          error: undefined,
        };
        result = {
          ok: true,
          value: {
            rules: result.value.rules.map((rule) => rule.id === ruleId ? stoppedRule : rule),
            rule: stoppedRule,
          },
        };
      }
      deps.updatePortForwardingRules(result.value.rules);
      return { ok: true, rule: sanitizePortForwardRuleForAgent(result.value.rule) };
    }
    case 'portforward.rules.duplicate': {
      const ruleId = String(params.ruleId || '');
      const effectiveHosts = deps.getHosts().map((host) => deps.resolveEffectiveHost(host));
      const result = duplicatePortForwardingRule(deps.getPortForwardingRules(), effectiveHosts, ruleId, {
        id: crypto.randomUUID(), now: Date.now(),
      });
      if (!result.ok) return result;
      deps.updatePortForwardingRules(result.value.rules);
      return { ok: true, rule: sanitizePortForwardRuleForAgent(result.value.rule) };
    }
    case 'portforward.rules.delete': {
      const ruleId = String(params.ruleId || '');
      const rule = deps.getPortForwardingRules().find((entry) => entry.id === ruleId);
      if (!rule) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
      const stopped = await deps.stopRuleTunnels(ruleId);
      if (!stopped.success) return { ok: false, error: stopped.error || 'Failed to stop port forwarding tunnel.' };
      deps.updatePortForwardingRules(deps.getPortForwardingRules().filter((entry) => entry.id !== ruleId));
      return { ok: true, ruleId };
    }
    case 'portforward.start': {
      const ruleId = String(params.ruleId || '');
      const rule = deps.getPortForwardingRules().find((entry) => entry.id === ruleId);
      if (!rule) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
      if (!rule.hostId) return { ok: false, error: 'Rule has no associated host.' };
      const effectiveHosts = deps.getHosts().map((host) => deps.resolveEffectiveHost(host));
      const validatedHost = validatePortForwardingHost(effectiveHosts, rule.hostId);
      if (!validatedHost.ok) return validatedHost;
      const host = validatedHost.value;
      try {
        resolveHostAuth({ host, keys: deps.keys, identities: deps.identities });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const result = await deps.startTunnel(
        rule,
        host,
        effectiveHosts,
        deps.keys,
        deps.identities,
        undefined,
        false,
        deps.terminalSettings,
        deps.knownHosts,
      );
      if (!result.success) {
        return { ok: false, error: result.error || 'Failed to start port forwarding tunnel.' };
      }
      return { ok: true, ruleId };
    }
    case 'portforward.stop': {
      const ruleId = String(params.ruleId || '');
      const result = await deps.stopRuleTunnels(ruleId);
      if (!result.success) {
        return { ok: false, error: result.error || 'Failed to stop port forwarding tunnel.' };
      }
      deps.updatePortForwardingRules(deps.getPortForwardingRules().map((rule) => (
        rule.id === ruleId ? { ...rule, status: 'inactive', error: undefined } : rule
      )));
      return { ok: true, ruleId };
    }
    default:
      return { ok: false, error: `Unknown vault agent operation "${op}".` };
  }
}

export function shouldBypassVaultAgentSerialization(
  op: string,
  params: Record<string, unknown>,
): boolean {
  if (op !== 'scripts.run' && op !== 'snippets.run') return false;
  return parseOptionalBoolean(params.wait) ?? false;
}

export type VaultAgentHandler = (op: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

let activeHandler: VaultAgentHandler | null = null;
let vaultAgentMutationChain: Promise<unknown> = Promise.resolve();

/** Serialize vault agent IPC handlers so read-modify-write mutations cannot clobber each other. */
export async function runSerializedVaultAgentRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = () => task();
  const next = vaultAgentMutationChain.then(run, run);
  vaultAgentMutationChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function registerVaultAgentHandler(handler: VaultAgentHandler | null): void {
  activeHandler = handler;
}

export function setupVaultAgentBridge(): () => void {
  const bridge = netcattyBridge.get();
  if (!bridge?.onVaultAgentRequest || !bridge.respondVaultAgent) {
    return () => {};
  }

  const unsubscribe = bridge.onVaultAgentRequest(async (payload) => {
    const { requestId, op, params } = payload;
    const safeParams = params || {};
    const runHandler = async () => {
      try {
        const result = activeHandler
          ? await activeHandler(op, safeParams)
          : { ok: false, error: 'Vault agent bridge is not ready.' };
        await bridge.respondVaultAgent?.(requestId, result);
      } catch (err) {
        await bridge.respondVaultAgent?.(requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (shouldBypassVaultAgentSerialization(op, safeParams)) {
      await runHandler();
      return;
    }

    await runSerializedVaultAgentRequest(runHandler);
  });

  return unsubscribe;
}
