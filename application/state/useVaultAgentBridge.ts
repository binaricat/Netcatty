import { useEffect, useRef } from 'react';
import { applyGroupDefaults, resolveGroupDefaults } from '../../domain/groupConfig';
import type { GroupConfig, Host, Identity, KnownHost, ManagedSource, PortForwardingRule, ProxyProfile, Snippet, SSHKey, TerminalSettings, VaultNote } from '../../domain/models';
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
  updateSnippets: (snippets: Snippet[]) => void;
  customGroups: string[];
  updateCustomGroups: (groups: string[]) => void;
  groupConfigs: GroupConfig[];
  updateGroupConfigs: (configs: GroupConfig[]) => void;
  updateManagedSources: (sources: ManagedSource[]) => void;
  updatePortForwardingRules: (rules: PortForwardingRule[]) => void;
  notes: VaultNote[];
  updateNotes: (notes: VaultNote[]) => void;
  startTunnel: VaultAgentApiDeps['startTunnel'];
  stopTunnel: VaultAgentApiDeps['stopTunnel'];
  stopRuleTunnels: VaultAgentApiDeps['stopRuleTunnels'];
  openHost?: VaultAgentApiDeps['openHost'];
  closeSession?: VaultAgentApiDeps['closeSession'];
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
  notes: input.notes,
  snippets: input.snippets,
  customGroups: input.customGroups,
  groupConfigs: input.groupConfigs,
  portForwardingRules: input.portForwardingRules,
  managedSources: input.managedSources,
});

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

  useEffect(() => {
    registerVaultAgentHandler(async (op, params) => {
      const current = inputRef.current;
      return handleVaultAgentOp(op, params, {
        getHosts: () => vaultSnapshotRef.current.hosts,
        getNotes: () => vaultSnapshotRef.current.notes,
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
          vaultSnapshotRef.current.notes = notes;
          current.updateNotes(notes);
        },
        updateSnippets: (nextSnippets) => {
          vaultSnapshotRef.current.snippets = nextSnippets;
          current.updateSnippets(nextSnippets);
        },
        startTunnel: current.startTunnel,
        stopTunnel: current.stopTunnel,
        stopRuleTunnels: current.stopRuleTunnels,
        openHost: current.openHost
          ? (host, isExternalMcpCall) => current.openHost!(host, isExternalMcpCall)
          : undefined,
        closeSession: current.closeSession
          ? (sessionId) => current.closeSession!(sessionId)
          : undefined,
      });
    });
    return setupVaultAgentBridge();
  }, []);
}
