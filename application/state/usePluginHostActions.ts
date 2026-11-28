import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostInteractionPrompt, VaultHostActionRequest } from '@netcatty/plugin-contract';
import { preparePluginHostStream } from '../../infrastructure/services/pluginHostStreamService';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { getAppHandlers } from '../app/appHandlersBridge';
import { getAppAppLockRuntime, getAppVaultRuntime, getAppSettingsRuntime } from './appRuntimeBridge';
import { PluginHostActionResources } from './pluginHostActionResources';
import { executePluginHostAction, type PluginHostAction } from './pluginHostActionExecution';
import { handlePluginVaultDataRequest } from './pluginVaultDataHandlers';
import { requestOpenDualPaneSftp } from './sftp/sftpDualPaneOpenStore';
import { pluginHostRunsSavedScripts, type PluginHostDraftFields } from '../../domain/pluginHostActions';
import type { Host, GroupConfig, ManagedSource, Snippet } from '../../domain/models';

export type VaultHostPrompt = Omit<HostInteractionPrompt, 'request'> & { request: VaultHostActionRequest };
type Review = {
  prompt: VaultHostPrompt;
  candidates: Host[];
  candidateRevisions: Map<string, string>;
  customGroups: string[];
  host?: Host;
  groups: GroupConfig[];
  snippets: Snippet[];
  managedSources: ManagedSource[];
  scriptsRun: boolean;
  claimed: boolean;
  completionToken?: string;
};

function isHostActionRequestKind(kind: string): boolean {
  return kind.startsWith('vault.')
    || kind === 'network.stream.connectViaHost'
    || kind === 'network.stream.confirm'
    || kind === 'network.stream.tlsConfirm';
}

export function usePluginHostActions() {
  const [review, setReview] = useState<Review | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const current = useRef<Review | null>(null);
  const resources = useRef(new PluginHostActionResources());
  const responding = useRef(false);

  const getVault = useCallback(() => {
    const vault = getAppVaultRuntime();
    const lock = getAppAppLockRuntime();
    if (!vault?.isInitialized || !lock?.initialized || lock.locked) throw new Error('Vault is locked or unavailable');
    const actionState = vault.readCurrentHostActionState();
    resources.current.observe(actionState.hosts);
    return { ...vault, ...actionState };
  }, []);

  const assertCurrent = useCallback((entry: Review) => {
    if (current.current !== entry || Date.now() >= entry.prompt.expiresAt) throw new Error('Host action expired');
    if (entry.prompt.request.kind === 'network.stream.confirm' || entry.prompt.request.kind === 'network.stream.tlsConfirm') {
      const lock = getAppAppLockRuntime();
      if (lock && lock.initialized && lock.locked) throw new Error('App is locked');
      return;
    }
    const vault = getVault();
    const target = entry.prompt.vaultTarget;
    if (entry.prompt.durableHostId) {
      const liveHost = vault.hosts.find((candidate) => candidate.id === entry.prompt.durableHostId);
      if (!liveHost || liveHost !== entry.host) throw new Error('Saved SSH host changed or was removed');
    } else if (target && resources.current.resolve(target.resourceId, target.revision) !== entry.host) {
      throw new Error('Selected host changed');
    }
    if ((entry.prompt.request.kind === 'vault.requestConnect' || entry.prompt.request.kind === 'network.stream.connectViaHost') && (vault.groupConfigs !== entry.groups || vault.snippets !== entry.snippets)) {
      throw new Error('Saved connection settings changed');
    }
    if (entry.prompt.request.kind === 'vault.requestHostDraft' && vault.managedSources !== entry.managedSources) throw new Error('Managed sources changed during draft review');
  }, [getVault]);

  const fail = useCallback(async (entry: Review) => {
    if (current.current !== entry) return;
    setError(true);
    try {
      await netcattyBridge.get()?.respondPluginInteraction?.({
        requestId: entry.prompt.requestId, actionToken: entry.completionToken ?? entry.prompt.actionToken, action: 'fail',
      });
    } catch { /* A stopped runtime or closed window already invalidates it. */ }
  }, []);

  const execute = useCallback(async (entry: Review) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.respondPluginInteraction) return fail(entry);
    setBusy(true);
    try {
      assertCurrent(entry);
      const request = entry.prompt.request;
      const target = entry.prompt.vaultTarget;
      if (request.kind === 'network.stream.connectViaHost' && entry.host && (target || entry.prompt.durableHostId)) {
        const vault = getVault();
        const settings = getAppSettingsRuntime();
        if (!settings || !bridge.openPluginHostStream) throw new Error('Host stream unavailable');
        const connectionOptions = await preparePluginHostStream(entry.host, vault, settings.terminalSettings);
        const assertPrepared = () => {
          assertCurrent(entry);
          const latest = getVault();
          if (latest.keys !== vault.keys || latest.identities !== vault.identities || latest.proxyProfiles !== vault.proxyProfiles
            || latest.hosts !== vault.hosts || latest.knownHosts !== vault.knownHosts || getAppSettingsRuntime()?.terminalSettings !== settings.terminalSettings) throw new Error('Connection settings changed');
        };
        assertPrepared();
        if (entry.prompt.durableHostId) {
          entry.claimed = true;
          await bridge.openPluginHostStream!({
            response: { requestId: entry.prompt.requestId, actionToken: entry.prompt.actionToken, action: 'commit' },
            connectionOptions,
          });
          return;
        }
        await executePluginHostAction({ kind: 'connect', target: target! }, {
          getVault, resources: resources.current, assertCurrent: assertPrepared,
          authorizeCommit: async () => { assertPrepared(); },
          connect: async () => {
            assertPrepared();
            entry.claimed = true;
            await bridge.openPluginHostStream!({ response: { requestId: entry.prompt.requestId, actionToken: entry.prompt.actionToken, action: 'commit' }, connectionOptions });
          },
        });
        return;
      }
      const openHostSession = (host: Host) => {
        const mode = request.kind === 'vault.requestConnect' ? (request.mode ?? 'terminal') : 'terminal';
        if (mode === 'sftp') {
          requestOpenDualPaneSftp(host.id);
          return;
        }
        const connect = getAppHandlers()?.handleConnectToHost;
        if (typeof connect !== 'function') throw new Error('Host connection flow unavailable');
        return connect(host);
      };
      if (request.kind === 'vault.requestConnect' && entry.prompt.durableHostId && entry.host) {
        assertCurrent(entry);
        const receipt = await bridge.respondPluginInteraction!({ requestId: entry.prompt.requestId, actionToken: entry.prompt.actionToken, action: 'commit' });
        if (!receipt || typeof receipt !== 'object' || !receipt.completionToken) throw new Error('Host action was revoked');
        entry.completionToken = receipt.completionToken;
        entry.claimed = true;
        assertCurrent(entry);
        await openHostSession(entry.host);
        await bridge.respondPluginInteraction({ requestId: entry.prompt.requestId, actionToken: entry.completionToken!, action: 'complete' });
        return;
      }
      let action: PluginHostAction;
      if (request.kind === 'vault.requestConnect' && target) action = { kind: 'connect', target };
      else if (request.kind === 'vault.requestHostDraft' && entry.prompt.reviewedDraft) {
        action = target ? { kind: 'edit', target, draft: entry.prompt.reviewedDraft } : { kind: 'create', draft: entry.prompt.reviewedDraft };
      } else throw new Error('Host action is invalid');
      await executePluginHostAction(action, {
        getVault, resources: resources.current,
        assertCurrent: () => assertCurrent(entry),
        authorizeCommit: async () => {
          assertCurrent(entry);
          const receipt = await bridge.respondPluginInteraction!({ requestId: entry.prompt.requestId, actionToken: entry.prompt.actionToken, action: 'commit' });
          if (!receipt || typeof receipt !== 'object' || !receipt.completionToken) throw new Error('Host action was revoked');
          entry.completionToken = receipt.completionToken;
          entry.claimed = true;
          assertCurrent(entry);
        },
        connect: openHostSession,
      });
      await bridge.respondPluginInteraction({ requestId: entry.prompt.requestId, actionToken: entry.completionToken!, action: 'complete' });
    } catch { await fail(entry); }
  }, [assertCurrent, fail, getVault]);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPluginInteraction) return;
    const unsubscribe = bridge.onPluginInteraction((event) => {
      if ('closed' in event) {
        if (current.current?.prompt.requestId !== event.requestId) return;
        current.current = null; setReview(null); setRemember(false); setBusy(false); responding.current = false;
        return;
      }
      if (!isHostActionRequestKind(event.request.kind)) return;
      const prompt = event as VaultHostPrompt;
      try {
        if (prompt.request.kind === 'network.stream.confirm' || prompt.request.kind === 'network.stream.tlsConfirm') {
          const entry: Review = {
            prompt, candidates: [], candidateRevisions: new Map(), customGroups: [],
            groups: [], snippets: [], managedSources: [], scriptsRun: false, claimed: false,
          };
          current.current = entry; setSelectedIds([]); setRemember(false); setBusy(false); setError(false); responding.current = false;
          setReview(entry);
          return;
        }
        if (prompt.phase === 'commit' && prompt.autoCommit && prompt.durableHostId && prompt.request.kind === 'network.stream.connectViaHost') {
          const vault = getVault();
          const host = vault.hosts.find((candidate) => candidate.id === prompt.durableHostId);
          if (!host) throw new Error('Saved SSH host no longer exists');
          const entry: Review = {
            prompt, candidates: [], candidateRevisions: new Map(), customGroups: vault.customGroups,
            host, groups: vault.groupConfigs, snippets: vault.snippets, managedSources: vault.managedSources,
            scriptsRun: false, claimed: false,
          };
          current.current = entry; setSelectedIds([]); setRemember(false); setBusy(true); setError(false); responding.current = false;
          setReview(null);
          void execute(entry);
          return;
        }
        if (prompt.phase === 'commit') {
          const entry = current.current;
          if (!entry || entry.prompt.requestId !== prompt.requestId || entry.prompt.request.kind !== prompt.request.kind) throw new Error('Host review is unavailable');
          entry.prompt = prompt;
          if (!(prompt.request.kind === 'vault.requestConnect' && prompt.permissionMode === 'allow')) setReview({ ...entry });
          void execute(entry);
          return;
        }
        const vault = getVault();
        const candidates = [...vault.hosts];
        const host = prompt.durableHostId
          ? vault.hosts.find((candidate) => candidate.id === prompt.durableHostId)
          : prompt.vaultTarget
            ? resources.current.resolve(prompt.vaultTarget.resourceId, prompt.vaultTarget.revision)
            : undefined;
        if (prompt.durableHostId && !host) throw new Error('Saved SSH host no longer exists');
        const entry: Review = {
          prompt, candidates, candidateRevisions: new Map(candidates.map((candidate) => [candidate.id, resources.current.metadata(candidate.id).revision])),
          customGroups: vault.customGroups, host, groups: vault.groupConfigs, snippets: vault.snippets,
          managedSources: vault.managedSources,
          scriptsRun: host ? pluginHostRunsSavedScripts(host, vault.groupConfigs, vault.snippets) : false,
          claimed: false,
        };
        const defaultRemember = prompt.request.kind === 'network.stream.connectViaHost'
          && 'durable' in prompt.request
          && prompt.request.durable === true;
        current.current = entry; setSelectedIds([]); setRemember(defaultRemember); setBusy(false); setError(false); responding.current = false;
        if (prompt.request.kind === 'vault.requestConnect' && prompt.permissionMode === 'allow') {
          setReview(null);
          void bridge.respondPluginInteraction?.({ requestId: prompt.requestId, actionToken: prompt.actionToken,
            action: 'submit', scriptsRun: entry.scriptsRun }).catch(() => void fail(entry));
        } else setReview(entry);
      } catch {
        void bridge.respondPluginInteraction?.({ requestId: prompt.requestId, actionToken: prompt.actionToken, action: 'fail' }).catch(() => {});
      }
    });
    return () => {
      const entry = current.current;
      current.current = null;
      unsubscribe();
      if (entry && !entry.claimed) void bridge.respondPluginInteraction?.({ requestId: entry.prompt.requestId, actionToken: entry.prompt.actionToken, action: 'cancel' }).catch(() => {});
    };
  }, [execute, fail, getVault]);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPluginVaultDataRequest || !bridge.respondPluginVaultData || !bridge.setPluginVaultDataReady) return;
    const unsubscribe = bridge.onPluginVaultDataRequest((request) => {
      void (async () => {
        try {
          const data = await handlePluginVaultDataRequest(request.kind, request.payload ?? {}, {
            getVault,
            resources: resources.current,
          });
          await bridge.respondPluginVaultData!({
            requestId: request.requestId,
            actionToken: request.actionToken,
            ok: true,
            data,
          });
        } catch (err) {
          await bridge.respondPluginVaultData!({
            requestId: request.requestId,
            actionToken: request.actionToken,
            ok: false,
            error: err instanceof Error ? err.message : 'Vault data request failed',
          }).catch(() => {});
        }
      })();
    });
    void bridge.setPluginVaultDataReady(true).catch(() => {});
    return () => {
      unsubscribe();
      void bridge.setPluginVaultDataReady?.(false).catch(() => {});
    };
  }, [getVault]);

  const respond = useCallback(async (action: 'cancel' | 'submit', draft?: PluginHostDraftFields, rememberOverride?: boolean) => {
    const entry = current.current;
    if (!entry || responding.current || (action === 'cancel' && entry.claimed)) return;
    responding.current = true; setBusy(true); setError(false);
    try {
      assertCurrent(entry);
      const request = entry.prompt.request;
      const selected = request.kind === 'vault.selectHosts' && action === 'submit' ? selectedIds.map((id) => {
        const revision = entry.candidateRevisions.get(id);
        if (!revision) throw new Error('Host was not part of the current selection');
        resources.current.resolve(id, revision);
        return resources.current.metadata(id);
      }) : undefined;
      const includeRemember = action === 'submit' && (
        request.kind === 'network.stream.connectViaHost'
        || request.kind === 'network.stream.confirm'
        || request.kind === 'network.stream.tlsConfirm'
      );
      const effectiveRemember = rememberOverride ?? remember;
      await netcattyBridge.require().respondPluginInteraction?.({
        requestId: entry.prompt.requestId, actionToken: entry.prompt.actionToken, action,
        ...(selected === undefined ? {} : { resources: selected }),
        ...(draft === undefined ? {} : { draft }),
        ...(request.kind === 'vault.requestConnect' && action === 'submit' ? { scriptsRun: entry.scriptsRun } : {}),
        ...(includeRemember && effectiveRemember ? { remember: true } : {}),
      });
    } catch { await fail(entry); }
    finally {
      if (current.current === entry && entry.prompt.phase === 'request') { responding.current = false; setBusy(false); }
    }
  }, [assertCurrent, fail, remember, selectedIds]);

  return { review, selectedIds, setSelectedIds, remember, setRemember, busy, error, respond };
}
