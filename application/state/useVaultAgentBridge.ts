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
  customGroups: string[];
  updateCustomGroups: (groups: string[]) => void;
  notes: VaultNote[];
  updateNotes: (notes: VaultNote[]) => void;
  startTunnel: VaultAgentApiDeps['startTunnel'];
  stopTunnel: VaultAgentApiDeps['stopTunnel'];
}

export function useVaultAgentBridge(input: UseVaultAgentBridgeInput): void {
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    registerVaultAgentHandler(async (op, params) => {
      const current = inputRef.current;
      return handleVaultAgentOp(op, params, {
        getHosts: () => inputRef.current.hosts,
        getNotes: () => inputRef.current.notes,
        getCustomGroups: () => inputRef.current.customGroups,
        snippets: current.snippets,
        portForwardingRules: current.portForwardingRules,
        keys: current.keys,
        identities: current.identities,
        terminalSettings: current.terminalSettings,
        resolveEffectiveHost: current.resolveEffectiveHost,
        updateHostNotes: (hostId, notes) => {
          inputRef.current.updateHosts(
            inputRef.current.hosts.map((host) => (host.id === hostId ? { ...host, notes } : host)),
          );
        },
        updateCustomGroups: current.updateCustomGroups,
        updateHosts: current.updateHosts,
        updateNotes: current.updateNotes,
        startTunnel: current.startTunnel,
        stopTunnel: current.stopTunnel,
      });
    });
    return setupVaultAgentBridge();
  }, []);
}
