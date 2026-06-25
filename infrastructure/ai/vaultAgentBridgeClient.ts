import type { Host, Identity, PortForwardingRule, Snippet, SSHKey, TerminalSettings } from '../../domain/models';
import { applySnippetVariables, parseSnippetVariables } from '../../domain/snippetVariables';
import { resolveHostAuth } from '../../domain/sshAuth';
import { netcattyBridge } from '../services/netcattyBridge';

const SENSITIVE_HOST_KEYS = new Set([
  'password',
  'telnetPassword',
  'privateKey',
  'passphrase',
]);

export function sanitizeHostForAgent(host: Host): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(host)) {
    if (SENSITIVE_HOST_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
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

export interface VaultAgentApiDeps {
  hosts: Host[];
  snippets: Snippet[];
  portForwardingRules: PortForwardingRule[];
  keys: SSHKey[];
  identities: Identity[];
  terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>;
  resolveEffectiveHost: (host: Host) => Host;
  updateHostNotes: (hostId: string, notes: string) => void;
  startTunnel: (
    rule: PortForwardingRule,
    host: Host,
    hosts: Host[],
    keys: SSHKey[],
    identities: Identity[],
    onStatusChange?: (status: PortForwardingRule['status'], error?: string) => void,
    enableReconnect?: boolean,
    terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>,
  ) => Promise<{ success: boolean; error?: string }>;
  stopTunnel: (
    ruleId: string,
    onStatusChange?: (status: PortForwardingRule['status']) => void,
  ) => Promise<{ success: boolean; error?: string }>;
}

export async function handleVaultAgentOp(
  op: string,
  params: Record<string, unknown>,
  deps: VaultAgentApiDeps,
): Promise<Record<string, unknown>> {
  switch (op) {
    case 'host.get': {
      const hostId = String(params.hostId || '');
      const host = deps.hosts.find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      return { ok: true, host: sanitizeHostForAgent(deps.resolveEffectiveHost(host)) };
    }
    case 'host.notes.get': {
      const hostId = String(params.hostId || '');
      const host = deps.hosts.find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      return { ok: true, hostId, notes: host.notes || '' };
    }
    case 'host.notes.set': {
      const hostId = String(params.hostId || '');
      const notes = typeof params.notes === 'string' ? params.notes : '';
      const host = deps.hosts.find((entry) => entry.id === hostId);
      if (!host) return { ok: false, error: `Host "${hostId}" was not found.` };
      deps.updateHostNotes(hostId, notes);
      return { ok: true, hostId };
    }
    case 'snippets.list': {
      return {
        ok: true,
        snippets: deps.snippets.map((snippet) => ({
          id: snippet.id,
          label: snippet.label,
          tags: snippet.tags || [],
          targets: snippet.targets || [],
          package: snippet.package,
        })),
      };
    }
    case 'snippets.get': {
      const snippetId = String(params.snippetId || '');
      const snippet = deps.snippets.find((entry) => entry.id === snippetId);
      if (!snippet) return { ok: false, error: `Snippet "${snippetId}" was not found.` };
      return {
        ok: true,
        snippet: {
          id: snippet.id,
          label: snippet.label,
          command: snippet.command,
          tags: snippet.tags || [],
          targets: snippet.targets || [],
          noAutoRun: snippet.noAutoRun,
        },
      };
    }
    case 'snippets.run': {
      const snippetId = String(params.snippetId || '');
      const sessionId = String(params.sessionId || '');
      const snippet = deps.snippets.find((entry) => entry.id === snippetId);
      if (!snippet) return { ok: false, error: `Snippet "${snippetId}" was not found.` };
      if (!sessionId) return { ok: false, error: 'sessionId is required.' };

      let variableValues: Record<string, string> = {};
      if (typeof params.variables === 'string' && params.variables.trim()) {
        try {
          const parsed = JSON.parse(params.variables) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            variableValues = Object.fromEntries(
              Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]),
            );
          }
        } catch {
          return { ok: false, error: 'variables must be a JSON object string.' };
        }
      }

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
      return { ok: true, sessionId, snippetId, command, result };
    }
    case 'portforward.rules.list': {
      return {
        ok: true,
        rules: deps.portForwardingRules.map(sanitizePortForwardRuleForAgent),
      };
    }
    case 'portforward.start': {
      const ruleId = String(params.ruleId || '');
      const rule = deps.portForwardingRules.find((entry) => entry.id === ruleId);
      if (!rule) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
      if (!rule.hostId) return { ok: false, error: 'Rule has no associated host.' };
      const rawHost = deps.hosts.find((entry) => entry.id === rule.hostId);
      if (!rawHost) return { ok: false, error: `Host "${rule.hostId}" was not found.` };
      const host = deps.resolveEffectiveHost(rawHost);
      try {
        resolveHostAuth({ host, keys: deps.keys, identities: deps.identities });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const effectiveHosts = deps.hosts.map((entry) => deps.resolveEffectiveHost(entry));
      const result = await deps.startTunnel(
        rule,
        host,
        effectiveHosts,
        deps.keys,
        deps.identities,
        undefined,
        false,
        deps.terminalSettings,
      );
      if (!result.success) {
        return { ok: false, error: result.error || 'Failed to start port forwarding tunnel.' };
      }
      return { ok: true, ruleId };
    }
    case 'portforward.stop': {
      const ruleId = String(params.ruleId || '');
      const result = await deps.stopTunnel(ruleId);
      if (!result.success) {
        return { ok: false, error: result.error || 'Failed to stop port forwarding tunnel.' };
      }
      return { ok: true, ruleId };
    }
    default:
      return { ok: false, error: `Unknown vault agent operation "${op}".` };
  }
}

export type VaultAgentHandler = (op: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

let activeHandler: VaultAgentHandler | null = null;

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
    try {
      const result = activeHandler
        ? await activeHandler(op, params || {})
        : { ok: false, error: 'Vault agent bridge is not ready.' };
      await bridge.respondVaultAgent?.(requestId, result);
    } catch (err) {
      await bridge.respondVaultAgent?.(requestId, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return unsubscribe;
}
