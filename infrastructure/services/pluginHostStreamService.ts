import type { Host, GroupConfig, ProxyProfile, SSHKey, Identity, KnownHost, TerminalSettings } from '../../domain/models';
import { applyGroupDefaults, resolveGroupDefaults } from '../../domain/groupConfig';
import { materializeHostProxyProfile } from '../../domain/proxyProfiles';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import { startPortForward } from './portForwardingService';

export async function preparePluginHostStream(host: Host, vault: {
  hosts: Host[]; groupConfigs: GroupConfig[]; proxyProfiles: ProxyProfile[];
  keys: SSHKey[]; identities: Identity[]; knownHosts: KnownHost[];
}, terminalSettings: TerminalSettings) {
  const validProxyProfileIds = new Set(vault.proxyProfiles.map((profile) => profile.id));
  const effective = (candidate: Host) => materializeHostProxyProfile(applyGroupDefaults(candidate,
    candidate.group ? resolveGroupDefaults(candidate.group, vault.groupConfigs, { validProxyProfileIds }) : {},
    { validProxyProfileIds }), vault.proxyProfiles);
  const selected = effective(host);
  if (resolveEffectiveTerminalProtocol(selected) !== 'ssh') throw new Error('Select an SSH server');
  const result = await startPortForward({
    id: `plugin-stream-${crypto.randomUUID()}`, label: selected.label,
    type: 'local', hostId: selected.id, localPort: 0,
    bindAddress: '127.0.0.1', status: 'inactive', createdAt: Date.now(),
  }, selected, vault.hosts.map(effective), vault.keys, vault.identities, () => {}, false,
  terminalSettings, vault.knownHosts, { dedicatedTransport: true, prepareOnly: true });
  if (!result.success || !result.connectionOptions) throw new Error('Could not prepare the selected SSH server');
  return result.connectionOptions;
}
