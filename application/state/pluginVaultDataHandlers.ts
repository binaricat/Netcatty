import type { Host, PortForwardingRule, Snippet } from '../../domain/models';
import { applyGroupDefaults, resolveGroupDefaults } from '../../domain/groupConfig';
import { materializeHostProxyProfile } from '../../domain/proxyProfiles';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import {
  migratePortForwardingRulesFromStorage,
  toPersistedPortForwardingRules,
} from '../../domain/portForwardingPersistence';
import { STORAGE_KEY_PORT_FORWARDING } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { preparePluginHostStream } from '../../infrastructure/services/pluginHostStreamService';
import { startPortForward, stopAndCleanupRule } from '../../infrastructure/services/portForwardingService';
import { captureScreenSnapshot } from '../../infrastructure/scripts/screenSnapshotRegistry';
import { activeTabStore } from './activeTabStore';
import {
  getAppSessionRuntime,
  getAppSettingsRuntime,
  type AppVaultRuntime,
} from './appRuntimeBridge';
import type { PluginHostActionResources } from './pluginHostActionResources';

export type PluginVaultDataContext = {
  getVault: () => AppVaultRuntime & ReturnType<AppVaultRuntime['readCurrentHostActionState']>;
  resources: PluginHostActionResources;
};

function readPortForwardRules(): PortForwardingRule[] {
  const raw = localStorageAdapter.read<PortForwardingRule[]>(STORAGE_KEY_PORT_FORWARDING);
  return migratePortForwardingRulesFromStorage(Array.isArray(raw) ? raw : []);
}

function writePortForwardRules(rules: PortForwardingRule[]): void {
  localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, toPersistedPortForwardingRules(rules));
}

function summarizePortForwardRule(rule: PortForwardingRule, hosts: readonly Host[]) {
  const host = rule.hostId ? hosts.find((candidate) => candidate.id === rule.hostId) : undefined;
  return {
    id: rule.id,
    label: rule.label,
    type: rule.type,
    localPort: rule.localPort,
    bindAddress: rule.bindAddress || '127.0.0.1',
    ...(rule.remoteHost ? { remoteHost: rule.remoteHost } : {}),
    ...(typeof rule.remotePort === 'number' && rule.remotePort >= 1 ? { remotePort: rule.remotePort } : {}),
    ...(host?.label ? { hostLabel: host.label } : {}),
    ...(host?.hostname ? { hostname: host.hostname } : {}),
    status: rule.status ?? 'inactive',
    ...(rule.error ? { error: rule.error.slice(0, 512) } : {}),
  };
}

function summarizeSnippet(snippet: Snippet) {
  return {
    id: snippet.id,
    label: snippet.label,
    command: snippet.command,
    ...(snippet.package ? { package: snippet.package } : {}),
    ...(Array.isArray(snippet.tags) && snippet.tags.length > 0 ? { tags: [...snippet.tags] } : {}),
    ...(snippet.shortcut ? { shortcut: snippet.shortcut } : {}),
  };
}

function effectiveHost(
  host: Host,
  vault: Pick<AppVaultRuntime, 'groupConfigs' | 'proxyProfiles'>,
): Host {
  const validProxyProfileIds = new Set(vault.proxyProfiles.map((p) => p.id));
  const defaults = host.group
    ? resolveGroupDefaults(host.group, vault.groupConfigs, { validProxyProfileIds })
    : {};
  return materializeHostProxyProfile(
    applyGroupDefaults(host, defaults, { validProxyProfileIds }),
    vault.proxyProfiles,
  );
}

export async function handlePluginVaultDataRequest(
  kind: string,
  payload: Record<string, unknown>,
  ctx: PluginVaultDataContext,
): Promise<unknown> {
  const vault = ctx.getVault();

  switch (kind) {
    case 'resolveMetadata': {
      const hostIds = Array.isArray(payload.hostIds) ? payload.hostIds : [];
      const hosts: Record<string, Record<string, unknown>> = {};
      for (const hostId of hostIds) {
        if (typeof hostId !== 'string') continue;
        const found = vault.hosts.find((candidate) => candidate.id === hostId);
        if (!found) continue;
        const { resourceId: _resourceId, revision: _revision, ...meta } = ctx.resources.metadata(found.id);
        hosts[hostId] = meta;
      }
      return { hosts };
    }

    case 'prepareConnection': {
      const hostId = typeof payload.hostId === 'string' ? payload.hostId : '';
      const host = vault.hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error('Saved SSH host no longer exists');
      const settings = getAppSettingsRuntime();
      if (!settings) throw new Error('Terminal settings unavailable');
      const connectionOptions = await preparePluginHostStream(host, vault, settings.terminalSettings);
      return { connectionOptions };
    }

    case 'prepareProbeTarget': {
      const hostId = typeof payload.hostId === 'string' ? payload.hostId : '';
      const rawHost = vault.hosts.find((candidate) => candidate.id === hostId);
      if (!rawHost) throw new Error('Saved host no longer exists');
      const host = effectiveHost(rawHost, vault);
      const defaultProtocol = resolveEffectiveTerminalProtocol(host);
      const rdpPort = host.rdpConfig?.port ?? (defaultProtocol === 'rdp' ? (host.port || 3389) : undefined);
      const vncPort = host.vncConfig?.port ?? (defaultProtocol === 'vnc' ? (host.port || 5900) : undefined);
      const isRemoteDesktopOnly = defaultProtocol === 'rdp' || defaultProtocol === 'vnc';
      return {
        hostname: host.hostname,
        ...(!isRemoteDesktopOnly ? { sshPort: host.port || 22 } : {}),
        ...(rdpPort ? { rdpPort } : {}),
        ...(vncPort ? { vncPort } : {}),
        defaultProtocol,
        ...(host.rdpConfig?.securityMode ? { rdpSecurityMode: host.rdpConfig.securityMode } : {}),
      };
    }

    case 'listGroups': {
      const counts = new Map<string, number>();
      for (const groupPath of vault.customGroups) {
        if (groupPath) counts.set(groupPath, counts.get(groupPath) ?? 0);
      }
      for (const host of vault.hosts) {
        if (host.group) counts.set(host.group, (counts.get(host.group) ?? 0) + 1);
      }
      const groups = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 1000)
        .map(([path, hostCount]) => ({ path, hostCount }));
      return { groups };
    }

    case 'updateHostNotes': {
      const hostId = typeof payload.hostId === 'string' ? payload.hostId : '';
      const notes = typeof payload.notes === 'string' ? payload.notes.slice(0, 4096) : '';
      const host = vault.hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error('Saved host no longer exists');
      if (host.managedSourceId) throw new Error('Managed SSH config hosts cannot be edited directly');
      vault.updateHosts((prev) => prev.map((item) => (item.id === hostId ? { ...item, notes } : item)));
      return { updated: true };
    }

    case 'updateHostTags': {
      const hostId = typeof payload.hostId === 'string' ? payload.hostId : '';
      const tags = Array.isArray(payload.tags)
        ? payload.tags.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 128)
        : [];
      const host = vault.hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error('Saved host no longer exists');
      if (host.managedSourceId) throw new Error('Managed SSH config hosts cannot be edited directly');
      vault.updateHosts((prev) => prev.map((item) => (item.id === hostId ? { ...item, tags } : item)));
      return { updated: true };
    }

    case 'portForward.list': {
      const rules = readPortForwardRules().slice(0, 500);
      return { rules: rules.map((rule) => summarizePortForwardRule(rule, vault.hosts)) };
    }

    case 'portForward.create': {
      const hostId = typeof payload.hostId === 'string' ? payload.hostId : '';
      const host = vault.hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error('Bound host no longer exists');
      const rule: PortForwardingRule = {
        id: crypto.randomUUID(),
        label: String(payload.label ?? '').slice(0, 256),
        type: (payload.type === 'remote' || payload.type === 'dynamic' ? payload.type : 'local'),
        localPort: Number(payload.localPort),
        bindAddress: typeof payload.bindAddress === 'string' && payload.bindAddress ? payload.bindAddress : '127.0.0.1',
        ...(typeof payload.remoteHost === 'string' ? { remoteHost: payload.remoteHost } : {}),
        ...(typeof payload.remotePort === 'number' ? { remotePort: payload.remotePort } : {}),
        hostId: host.id,
        status: 'inactive',
        createdAt: Date.now(),
      };
      const existing = readPortForwardRules();
      writePortForwardRules([...existing, rule]);
      return { ok: true, rule: summarizePortForwardRule(rule, vault.hosts) };
    }

    case 'portForward.start': {
      const ruleId = typeof payload.ruleId === 'string' ? payload.ruleId : '';
      const rules = readPortForwardRules();
      const rule = rules.find((item) => item.id === ruleId);
      if (!rule) return { ok: false, error: 'Port forwarding rule not found' };
      const rawHost = rule.hostId ? vault.hosts.find((h) => h.id === rule.hostId) : undefined;
      if (!rawHost) return { ok: false, error: 'Target host for port forwarding rule not found' };
      const settings = getAppSettingsRuntime();
      const resolvedHost = effectiveHost(rawHost, vault);
      const resolvedHosts = vault.hosts.map((h) => effectiveHost(h, vault));
      const res = await startPortForward(
        rule,
        resolvedHost,
        resolvedHosts,
        vault.keys,
        vault.identities,
        (status, error) => {
          const latest = readPortForwardRules();
          writePortForwardRules(latest.map((item) => (item.id === ruleId ? { ...item, status, error } : item)));
        },
        false,
        settings?.terminalSettings,
        vault.knownHosts,
      );
      const updated = readPortForwardRules().find((item) => item.id === ruleId) ?? rule;
      return {
        ok: Boolean(res.success),
        rule: summarizePortForwardRule(updated, vault.hosts),
        ...(res.error ? { error: String(res.error).slice(0, 512) } : {}),
      };
    }

    case 'portForward.stop': {
      const ruleId = typeof payload.ruleId === 'string' ? payload.ruleId : '';
      const rules = readPortForwardRules();
      const rule = rules.find((item) => item.id === ruleId);
      if (!rule) return { ok: false, error: 'Port forwarding rule not found' };
      await stopAndCleanupRule(ruleId);
      const latestRules = readPortForwardRules();
      const nextRules = latestRules.map((item) => (item.id === ruleId ? { ...item, status: 'inactive' as const, error: undefined } : item));
      writePortForwardRules(nextRules);
      const updated = nextRules.find((item) => item.id === ruleId) ?? rule;
      return { ok: true, rule: summarizePortForwardRule(updated, vault.hosts) };
    }

    case 'portForward.delete': {
      const ruleId = typeof payload.ruleId === 'string' ? payload.ruleId : '';
      const rules = readPortForwardRules();
      if (!rules.some((item) => item.id === ruleId)) {
        return { ok: false, error: 'Port forwarding rule not found' };
      }
      await stopAndCleanupRule(ruleId).catch(() => {});
      const latestRules = readPortForwardRules();
      writePortForwardRules(latestRules.filter((item) => item.id !== ruleId));
      return { ok: true };
    }

    case 'snippets.list': {
      const query = typeof payload.query === 'string' ? payload.query.trim().toLowerCase() : '';
      const tag = typeof payload.tag === 'string' ? payload.tag : '';
      const pkg = typeof payload.package === 'string' ? payload.package : '';
      const filtered = vault.snippets.filter((snippet) => {
        if (pkg && snippet.package !== pkg) return false;
        if (tag && !(snippet.tags ?? []).includes(tag)) return false;
        if (query) {
          const hay = `${snippet.label} ${snippet.command} ${(snippet.tags ?? []).join(' ')}`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });
      return { snippets: filtered.slice(0, 1000).map(summarizeSnippet) };
    }

    case 'snippets.get': {
      const id = typeof payload.id === 'string' ? payload.id : '';
      const found = vault.snippets.find((item) => item.id === id);
      return found ? { found: true, snippet: summarizeSnippet(found) } : { found: false };
    }

    case 'snippets.save': {
      const id = typeof payload.id === 'string' && payload.id ? payload.id : crypto.randomUUID();
      const existing = vault.snippets.find((item) => item.id === id);
      const nextSnippet: Snippet = {
        ...(existing ?? {}),
        id,
        label: String(payload.label ?? '').slice(0, 256),
        command: String(payload.command ?? '').slice(0, 65536),
        ...(typeof payload.package === 'string' ? { package: payload.package } : {}),
        ...(Array.isArray(payload.tags) ? { tags: payload.tags.filter((t): t is string => typeof t === 'string') } : {}),
        ...(typeof payload.shortcut === 'string' ? { shortcut: payload.shortcut } : {}),
      };
      const nextList = existing
        ? vault.snippets.map((item) => (item.id === id ? nextSnippet : item))
        : [...vault.snippets, nextSnippet];
      vault.updateSnippets(nextList);
      return { snippet: summarizeSnippet(nextSnippet) };
    }

    case 'snippets.delete': {
      const id = typeof payload.id === 'string' ? payload.id : '';
      const exists = vault.snippets.some((item) => item.id === id);
      if (exists) {
        vault.updateSnippets(vault.snippets.filter((item) => item.id !== id));
      }
      return { deleted: exists };
    }

    case 'terminals.listSessions': {
      const sessionRuntime = getAppSessionRuntime();
      const activeId = activeTabStore.getActiveTabId();
      const sessions = (sessionRuntime?.sessions ?? []).slice(0, 200).map((session) => ({
        sessionId: session.id,
        label: session.hostLabel || session.hostname || session.id,
        hostname: session.hostname || '',
        ...(session.username ? { username: session.username } : {}),
        protocol: session.protocol || 'ssh',
        status: session.status || 'connecting',
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        active: session.id === activeId || (Boolean(session.workspaceId) && session.workspaceId === activeId),
      }));
      return { sessions };
    }

    case 'terminals.readScreen': {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const maxRows = typeof payload.maxRows === 'number' ? Math.max(1, Math.min(300, payload.maxRows)) : 80;
      const sessionRuntime = getAppSessionRuntime();
      if (!sessionRuntime?.sessions.some((s) => s.id === sessionId)) {
        throw new Error('Terminal session not found');
      }
      const snapshot = captureScreenSnapshot(sessionId);
      const lines = (snapshot.lines ?? []).slice(-maxRows);
      return {
        sessionId,
        rows: snapshot.rows ?? lines.length,
        cols: snapshot.cols ?? 80,
        lines,
      };
    }

    case 'terminals.sendInput': {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const data = typeof payload.data === 'string' ? payload.data : '';
      const sessionRuntime = getAppSessionRuntime();
      if (!sessionRuntime?.sessions.some((s) => s.id === sessionId)) {
        throw new Error('Terminal session not found');
      }
      const bridge = netcattyBridge.get();
      if (!bridge?.writeToSession) throw new Error('Terminal input bridge is unavailable');
      bridge.writeToSession(sessionId, data);
      return { sent: true };
    }

    case 'terminals.openLocal': {
      const sessionRuntime = getAppSessionRuntime();
      if (!sessionRuntime?.createLocalTerminal) throw new Error('Local terminal is unavailable');
      const sessionId = sessionRuntime.createLocalTerminal();
      return { opened: true, ...(typeof sessionId === 'string' ? { sessionId } : {}) };
    }

    case 'workspace.listTabs': {
      const sessionRuntime = getAppSessionRuntime();
      const activeTabId = activeTabStore.getActiveTabId();
      const tabs: Array<{ id: string; kind: 'vault' | 'sftp' | 'session' | 'workspace' | 'log'; title: string; active: boolean }> = [
        { id: 'vault', kind: 'vault', title: 'Vault', active: activeTabId === 'vault' },
        { id: 'sftp', kind: 'sftp', title: 'SFTP', active: activeTabId === 'sftp' },
      ];
      for (const workspace of sessionRuntime?.workspaces ?? []) {
        tabs.push({ id: workspace.id, kind: 'workspace', title: workspace.title || 'Workspace', active: activeTabId === workspace.id });
      }
      for (const session of sessionRuntime?.sessions ?? []) {
        if (session.workspaceId) continue;
        tabs.push({ id: session.id, kind: 'session', title: session.hostLabel || session.hostname || 'Terminal', active: activeTabId === session.id });
      }
      for (const logView of sessionRuntime?.logViews ?? []) {
        tabs.push({ id: logView.id, kind: 'log', title: logView.title || 'Log', active: activeTabId === logView.id });
      }
      return { activeTabId, tabs: tabs.slice(0, 200) };
    }

    case 'workspace.focusTab': {
      const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
      const sessionRuntime = getAppSessionRuntime();
      const known = new Set<string>(['vault', 'sftp']);
      for (const workspace of sessionRuntime?.workspaces ?? []) known.add(workspace.id);
      for (const session of sessionRuntime?.sessions ?? []) {
        if (!session.workspaceId) known.add(session.id);
      }
      for (const logView of sessionRuntime?.logViews ?? []) known.add(logView.id);
      let resolvedTabId = known.has(tabId) ? tabId : null;
      if (!resolvedTabId) {
        const memberSession = (sessionRuntime?.sessions ?? []).find((s) => s.id === tabId && s.workspaceId);
        if (memberSession?.workspaceId && known.has(memberSession.workspaceId)) {
          resolvedTabId = memberSession.workspaceId;
        }
      }
      if (!resolvedTabId) return { focused: false };
      if (sessionRuntime?.setActiveTabId) sessionRuntime.setActiveTabId(resolvedTabId);
      else activeTabStore.setActiveTabId(resolvedTabId);
      return { focused: true };
    }

    default:
      throw new Error(`Unsupported Vault data request: ${kind}`);
  }
}
