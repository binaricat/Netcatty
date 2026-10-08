import { useEffect, useRef } from 'react';
import { applyGroupDefaults, resolveGroupDefaults } from '../../domain/groupConfig';
import type { GroupConfig, Host, Identity, KnownHost, ManagedSource, PortForwardingRule, ProxyProfile, Snippet, SSHKey, TerminalSession, TerminalSettings, VaultNote } from '../../domain/models';
import { materializeHostProxyProfile } from '../../domain/proxyProfiles';
import {
  handleVaultAgentOp,
  registerVaultAgentHandler,
  setupVaultAgentBridge,
  type VaultAgentApiDeps,
} from '../../infrastructure/ai/vaultAgentBridgeClient';
import {
  clearRememberedKeyPassphrases,
  readRememberedKeyPassphrases,
  rememberImportedKeyPassphrase,
  rememberKeyPassphrase,
  resolveDefaultKeyPassphraseAliases,
} from '../defaultKeyPassphrases';
import { getNotesActions, getNotesSnapshot, subscribeNotes } from './notesStore';
import type {
  VaultGroupMutationResult,
  VaultGroupMutationState,
} from '../../domain/vaultGroupMutation';

export interface UseVaultAgentBridgeInput {
  hosts: Host[];
  snippets: Snippet[];
  portForwardingRules: PortForwardingRule[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts: KnownHost[];
  proxyProfiles: ProxyProfile[];
  managedSources: ManagedSource[];
  terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>;
  updateHosts: (hosts: Host[]) => void;
  updateKeys: (keys: SSHKey[]) => Promise<unknown> | unknown;
  updateSnippets: (
    snippets: Snippet[] | ((current: Snippet[]) => Snippet[]),
  ) => void;
  customGroups: string[];
  updateCustomGroups: (groups: string[]) => void;
  groupConfigs: GroupConfig[];
  updateGroupConfigs: (configs: GroupConfig[]) => void;
  updateManagedSources: (sources: ManagedSource[]) => void;
  commitVaultGroupMutation: (
    mutate: (current: VaultGroupMutationState) => VaultGroupMutationResult,
  ) => Promise<VaultGroupMutationResult | { ok: false; superseded: true }>;
  updatePortForwardingRules: (rules: PortForwardingRule[]) => void;
  /** Optional override; defaults to notesStore so App need not subscribe to notes. */
  notes?: VaultNote[];
  /** Optional override; defaults to notesStore actions. */
  updateNotes?: (notes: VaultNote[]) => void;
  startTunnel: VaultAgentApiDeps['startTunnel'];
  stopTunnel: VaultAgentApiDeps['stopTunnel'];
  stopRuleTunnels: VaultAgentApiDeps['stopRuleTunnels'];
  openHost?: VaultAgentApiDeps['openHost'];
  findExistingSessionForHost?: VaultAgentApiDeps['findExistingSessionForHost'];
  closeSession?: VaultAgentApiDeps['closeSession'];
  getScriptSessionMeta?: (sessionId: string) => Pick<TerminalSession, 'status' | 'customName' | 'hostLabel' | 'hostname' | 'username'> | undefined;
}

type VaultAgentSnapshot = {
  hosts: Host[];
  keys: SSHKey[];
  notes: VaultNote[];
  snippets: Snippet[];
  customGroups: string[];
  groupConfigs: GroupConfig[];
  portForwardingRules: PortForwardingRule[];
  managedSources: ManagedSource[];
};

const selectVaultAgentSnapshot = (input: UseVaultAgentBridgeInput): VaultAgentSnapshot => ({
  hosts: input.hosts,
  keys: input.keys,
  notes: input.notes ?? (getNotesSnapshot().notes as VaultNote[]),
  snippets: input.snippets,
  customGroups: input.customGroups,
  groupConfigs: input.groupConfigs,
  portForwardingRules: input.portForwardingRules,
  managedSources: input.managedSources,
});

/** Resolve notes for agent ops: live store wins when App omitted the prop. */
export function resolveVaultAgentNotes(
  notesOverride: VaultNote[] | undefined,
  snapshotNotes: VaultNote[],
): VaultNote[] {
  return notesOverride !== undefined
    ? snapshotNotes
    : (getNotesSnapshot().notes as VaultNote[]);
}

export function applyAgentNotesUpdate(
  notes: VaultNote[],
  previousNotes: VaultNote[],
  updateNotes: (notes: VaultNote[]) => boolean | void,
): boolean | void {
  const saved = updateNotes(notes);
  if (saved === false) {
    // Editor autosave keeps failed writes in memory so a draft is not lost.
    // Agent writes must roll that draft back before another approved write.
    updateNotes(previousNotes);
  }
  return saved;
}

export const haveSameVaultAgentSnapshot = (
  left: VaultAgentSnapshot,
  right: VaultAgentSnapshot,
): boolean => (Object.keys(left) as Array<keyof VaultAgentSnapshot>)
  .every((key) => left[key] === right[key]);

export function resolveVaultAgentEffectiveHost(
  host: Host,
  groupConfigs: GroupConfig[],
  proxyProfiles: ProxyProfile[],
): Host {
  const validProxyProfileIds = new Set(proxyProfiles.map((profile) => profile.id));
  const withGroupDefaults = host.group
    ? applyGroupDefaults(
        host,
        resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds }),
        { validProxyProfileIds },
      )
    : applyGroupDefaults(host, {}, { validProxyProfileIds });
  return materializeHostProxyProfile(withGroupDefaults, proxyProfiles);
}

export function useVaultAgentBridge(input: UseVaultAgentBridgeInput): void {
  const inputRef = useRef(input);
  inputRef.current = input;

  const selectedSnapshot = selectVaultAgentSnapshot(input);
  const vaultSnapshotRef = useRef<VaultAgentSnapshot>(selectedSnapshot);
  const lastSyncedVaultInputRef = useRef<VaultAgentSnapshot>(selectedSnapshot);

  if (!haveSameVaultAgentSnapshot(selectedSnapshot, lastSyncedVaultInputRef.current)) {
    vaultSnapshotRef.current = selectedSnapshot;
    lastSyncedVaultInputRef.current = selectedSnapshot;
  }

  // Keep notes fresh without forcing App to re-render on every note edit.
  // Write in place: this object is also `lastSyncedVaultInputRef.current`, and
  // the agent op handlers below rely on that aliasing so their writes survive
  // the render-time comparison above. Replacing the object would break it.
  useEffect(() => {
    if (input.notes !== undefined) return;
    const syncNotes = () => {
      vaultSnapshotRef.current.notes = getNotesSnapshot().notes as VaultNote[];
    };
    syncNotes();
    return subscribeNotes(syncNotes);
  }, [input.notes]);

  useEffect(() => {
    registerVaultAgentHandler(async (op, params) => {
      const current = inputRef.current;
      const applyUpdateNotes = current.updateNotes
        ?? getNotesActions()?.updateNotes
        ?? ((notes: VaultNote[]) => {
          console.warn('[useVaultAgentBridge] updateNotes unavailable');
          void notes;
          return false;
        });
      return handleVaultAgentOp(op, params, {
        getHosts: () => vaultSnapshotRef.current.hosts,
        getNotes: () => resolveVaultAgentNotes(
          current.notes,
          vaultSnapshotRef.current.notes,
        ),
        getCustomGroups: () => vaultSnapshotRef.current.customGroups,
        getGroupConfigs: () => vaultSnapshotRef.current.groupConfigs,
        getPortForwardingRules: () => vaultSnapshotRef.current.portForwardingRules,
        getManagedSources: () => vaultSnapshotRef.current.managedSources,
        snippets: vaultSnapshotRef.current.snippets,
        keys: vaultSnapshotRef.current.keys,
        identities: current.identities,
        knownHosts: current.knownHosts,
        proxyProfiles: current.proxyProfiles,
        terminalSettings: current.terminalSettings,
        resolveEffectiveHost: (host) => resolveVaultAgentEffectiveHost(
          host,
          vaultSnapshotRef.current.groupConfigs,
          current.proxyProfiles,
        ),
        updateHostNotes: (hostId, notes) => {
          const nextHosts = vaultSnapshotRef.current.hosts.map((host) => (
            host.id === hostId ? { ...host, notes } : host
          ));
          vaultSnapshotRef.current.hosts = nextHosts;
          current.updateHosts(nextHosts);
        },
        updateCustomGroups: (groups) => {
          vaultSnapshotRef.current.customGroups = groups;
          current.updateCustomGroups(groups);
        },
        updateGroupConfigs: (configs) => {
          vaultSnapshotRef.current.groupConfigs = configs;
          current.updateGroupConfigs(configs);
        },
        updatePortForwardingRules: (rules) => {
          vaultSnapshotRef.current.portForwardingRules = rules;
          current.updatePortForwardingRules(rules);
        },
        updateManagedSources: (sources) => {
          vaultSnapshotRef.current.managedSources = sources;
          current.updateManagedSources(sources);
        },
        updateHosts: (hosts) => {
          vaultSnapshotRef.current.hosts = hosts;
          current.updateHosts(hosts);
        },
        commitVaultGroupMutation: async (mutate) => {
          const result = await current.commitVaultGroupMutation(mutate);
          if (result.ok) {
            vaultSnapshotRef.current.customGroups = result.state.groups;
            vaultSnapshotRef.current.groupConfigs = result.state.configs;
            vaultSnapshotRef.current.hosts = result.state.hosts;
            vaultSnapshotRef.current.managedSources = result.state.managedSources;
            vaultSnapshotRef.current.snippets = result.state.snippets;
          }
          return result;
        },
        saveKeyPassphrase: (keyPath, passphrase) => rememberKeyPassphrase({
          keyPath,
          passphrase,
          keys: vaultSnapshotRef.current.keys,
          getKeys: () => vaultSnapshotRef.current.keys,
          updateKeys: current.updateKeys,
          setCurrentKeys: (keys) => {
            vaultSnapshotRef.current.keys = keys;
          },
        }),
        saveImportedKeyPassphrase: (keyPath, passphrase) => rememberImportedKeyPassphrase({
          keyPath,
          passphrase,
          keys: vaultSnapshotRef.current.keys,
          getKeys: () => vaultSnapshotRef.current.keys,
          updateKeys: current.updateKeys,
          setCurrentKeys: (keys) => {
            vaultSnapshotRef.current.keys = keys;
          },
        }),
        resolveKeyPassphraseAliases: resolveDefaultKeyPassphraseAliases,
        readKeyPassphrases: (keyPath) => readRememberedKeyPassphrases(
          keyPath,
          vaultSnapshotRef.current.keys,
        ),
        removeKeyPassphrases: (keyPaths) => clearRememberedKeyPassphrases({
          keyPaths,
          getKeys: () => vaultSnapshotRef.current.keys,
          setCurrentKeys: (keys) => {
            vaultSnapshotRef.current.keys = keys;
          },
          updateKeys: current.updateKeys,
        }),
        updateNotes: (notes) => {
          const previousNotes = vaultSnapshotRef.current.notes;
          const saved = applyAgentNotesUpdate(notes, previousNotes, applyUpdateNotes);
          vaultSnapshotRef.current.notes = saved === false ? previousNotes : notes;
          return saved;
        },
        updateSnippets: (snippetUpdate) => {
          vaultSnapshotRef.current.snippets = typeof snippetUpdate === 'function'
            ? snippetUpdate(vaultSnapshotRef.current.snippets)
            : snippetUpdate;
          current.updateSnippets(snippetUpdate);
        },
        startTunnel: current.startTunnel,
        stopTunnel: current.stopTunnel,
        stopRuleTunnels: current.stopRuleTunnels,
        openHost: current.openHost
          ? (host, isExternalMcpCall) => current.openHost!(host, isExternalMcpCall)
          : undefined,
        findExistingSessionForHost: current.findExistingSessionForHost,
        closeSession: current.closeSession
          ? (sessionId) => current.closeSession!(sessionId)
          : undefined,
        getScriptSessionMeta: (sessionId) => {
          const session = current.getScriptSessionMeta?.(sessionId);
          if (!session) return undefined;
          return {
            connected: session.status === 'connected',
            name: session.customName || session.hostLabel,
            hostname: session.hostname,
            username: session.username,
          };
        },
      });
    });
    return setupVaultAgentBridge();
  }, []);
}
