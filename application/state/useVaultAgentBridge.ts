import { useEffect, useRef } from 'react';
import type { Host, Identity, PortForwardingRule, Snippet, SSHKey, TerminalSettings } from '../../domain/models';
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
        hosts: current.hosts,
        snippets: current.snippets,
        portForwardingRules: current.portForwardingRules,
        keys: current.keys,
        identities: current.identities,
        terminalSettings: current.terminalSettings,
        resolveEffectiveHost: current.resolveEffectiveHost,
        updateHostNotes: (hostId, notes) => {
          current.updateHosts(
            current.hosts.map((host) => (host.id === hostId ? { ...host, notes } : host)),
          );
        },
        startTunnel: current.startTunnel,
        stopTunnel: current.stopTunnel,
      });
    });
    return setupVaultAgentBridge();
  }, []);
}
