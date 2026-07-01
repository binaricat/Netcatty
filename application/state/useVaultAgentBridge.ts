import { useEffect, useRef } from 'react';
import type { Host, Identity, PortForwardingRule, Snippet, SSHKey, TerminalSettings, VaultNote } from '../../domain/models';
import {
  handleVaultAgentOp,
  registerVaultAgentHandler,
  setupVaultAgentBridge,
  type VaultAgentApiDeps,
} from '../../infrastructure/ai/vaultAgentBridgeClient';

export interface UseVaultAgentBridgeInput {
  hosts: Host[];
  snippets: Snippet[];
  portForwardingRules: PortForwardingRule[];
  keys: SSHKey[];
  identities: Identity[];
  terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>;
  resolveEffectiveHost: (host: Host) => Host;
  updateHosts: (hosts: Host[]) => void;
  updateSnippets: (snippets: Snippet[]) => void;
  customGroups: string[];
  updateCustomGroups: (groups: string[]) => void;
  notes: VaultNote[];
  updateNotes: (notes: VaultNote[]) => void;
  startTunnel: VaultAgentApiDeps['startTunnel'];
  stopTunnel: VaultAgentApiDeps['stopTunnel'];
}

type VaultAgentSnapshot = {
  hosts: Host[];
  notes: VaultNote[];
  snippets: Snippet[];
  customGroups: string[];
};

export function useVaultAgentBridge(input: UseVaultAgentBridgeInput): void {
  const inputRef = useRef(input);
  inputRef.current = input;

  const vaultSnapshotRef = useRef<VaultAgentSnapshot>({
    hosts: input.hosts,
    notes: input.notes,
    snippets: input.snippets,
    customGroups: input.customGroups,
  });
  const lastSyncedVaultInputRef = useRef({
    hosts: input.hosts,
    notes: input.notes,
    snippets: input.snippets,
    customGroups: input.customGroups,
  });

  if (
    input.hosts !== lastSyncedVaultInputRef.current.hosts
    || input.notes !== lastSyncedVaultInputRef.current.notes
    || input.snippets !== lastSyncedVaultInputRef.current.snippets
    || input.customGroups !== lastSyncedVaultInputRef.current.customGroups
  ) {
    vaultSnapshotRef.current = {
      hosts: input.hosts,
      notes: input.notes,
      snippets: input.snippets,
      customGroups: input.customGroups,
    };
    lastSyncedVaultInputRef.current = {
      hosts: input.hosts,
      notes: input.notes,
      snippets: input.snippets,
      customGroups: input.customGroups,
    };
  }

  useEffect(() => {
    registerVaultAgentHandler(async (op, params) => {
      const current = inputRef.current;
      return handleVaultAgentOp(op, params, {
        getHosts: () => vaultSnapshotRef.current.hosts,
        getNotes: () => vaultSnapshotRef.current.notes,
        getCustomGroups: () => vaultSnapshotRef.current.customGroups,
        snippets: vaultSnapshotRef.current.snippets,
        portForwardingRules: current.portForwardingRules,
        keys: current.keys,
        identities: current.identities,
        terminalSettings: current.terminalSettings,
        resolveEffectiveHost: current.resolveEffectiveHost,
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
        updateHosts: (hosts) => {
          vaultSnapshotRef.current.hosts = hosts;
          current.updateHosts(hosts);
        },
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
      });
    });
    return setupVaultAgentBridge();
  }, []);
}
