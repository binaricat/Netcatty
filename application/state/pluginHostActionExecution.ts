import type { Host, GroupConfig, Snippet, ManagedSource } from '../../domain/models';
import { canonicalJsonString, normalizeJsonValue } from '../../domain/convergentSync/json';
import { applyPluginHostEdit, normalizePluginHostDraft, pluginHostDraftTouchesManagedSource, type PluginHostDraftFields } from '../../domain/pluginHostActions';
import { applyVaultHostCreates } from '../../domain/vaultHostCreate';
import type { PluginHostActionResources } from './pluginHostActionResources';
import type { AppVaultRuntime } from './appRuntimeBridge';

// Application action model. Public RPC types live only in plugin-contract.
export type PluginHostAction =
  | { kind: 'create'; draft: PluginHostDraftFields }
  | { kind: 'edit'; target: { resourceId: string; revision: string }; draft: PluginHostDraftFields }
  | { kind: 'connect'; target: { resourceId: string; revision: string } };

export interface PluginHostActionVault {
  hosts: Host[];
  customGroups: string[];
  groupConfigs: GroupConfig[];
  snippets: Snippet[];
  managedSources: ManagedSource[];
  isInitialized: boolean;
  readPersistedHosts: () => Promise<Host[]>;
  commitVaultImportTransaction: AppVaultRuntime['commitVaultImportTransaction'];
}

export interface PluginHostActionExecution {
  getVault: () => PluginHostActionVault;
  resources: PluginHostActionResources;
  assertCurrent: () => void;
  authorizeCommit: () => Promise<void>;
  connect: (host: Host) => unknown;
}

const sameHost = (left: Host, right: Host) => (
  canonicalJsonString(normalizeJsonValue(left)) === canonicalJsonString(normalizeJsonValue(right))
);

/** Execute only a host-reviewed action. authorizeCommit claims separate,
 * one-use main-process action authority after the final asynchronous work. */
export async function executePluginHostAction(action: PluginHostAction, options: PluginHostActionExecution): Promise<'saved' | 'requested'> {
  const current = () => {
    options.assertCurrent();
    const vault = options.getVault();
    if (!vault.isInitialized) throw new Error('Vault is unavailable');
    options.resources.observe(vault.hosts);
    return vault;
  };
  const initialVault = current();
  const reviewedGroups = initialVault.groupConfigs;
  const reviewedSnippets = initialVault.snippets;
  const reviewedSources = initialVault.managedSources;
  const selected = action.kind === 'create' ? undefined : options.resources.resolve(action.target.resourceId, action.target.revision);
  const assertSelected = () => {
    const vault = current();
    if (action.kind !== 'create' && options.resources.resolve(action.target.resourceId, action.target.revision) !== selected) {
      throw new Error('Selected host changed');
    }
    // A connection preview includes inherited and global automation. Any
    // settings change while the preview is open requires fresh confirmation.
    if (action.kind === 'connect' && (vault.groupConfigs !== reviewedGroups || vault.snippets !== reviewedSnippets)) {
      throw new Error('Saved connection settings changed');
    }
    if (action.kind !== 'connect' && vault.managedSources !== reviewedSources) throw new Error('Managed sources changed during draft review');
    return vault;
  };
  const persisted = await initialVault.readPersistedHosts();
  assertSelected();
  if (selected) {
    const persistedHost = persisted.find((host) => host.id === selected.id);
    if (!persistedHost || !sameHost(selected, persistedHost)) throw new Error('Selected host changed');
  }
  if (action.kind === 'connect') {
    await options.authorizeCommit();
    assertSelected();
    // The existing host connection handler owns authentication, saved scripts,
    // and sessions. Its return value never reaches the sandboxed plugin.
    options.connect(selected!);
    return 'requested';
  }
  const nextHost = action.kind === 'create'
    ? normalizePluginHostDraft(action.draft, crypto.randomUUID())
    : applyPluginHostEdit(selected!, action.draft);
  if (pluginHostDraftTouchesManagedSource(nextHost, reviewedSources)) {
    throw new Error('Managed SSH config changes require the Vault host editor');
  }
  const nextHosts = action.kind === 'create'
    ? applyVaultHostCreates(persisted, [], [nextHost]).hosts
    : persisted.map((host) => host.id === nextHost.id ? nextHost : host);
  if (action.kind === 'create' && nextHosts.length !== persisted.length + 1) throw new Error('Host already exists');
  const updateGroups = (groups: string[]) => nextHost.group && !groups.includes(nextHost.group) ? [...groups, nextHost.group] : groups;
  const sourceSnapshot = canonicalJsonString(normalizeJsonValue(reviewedSources));
  const keepSources = (sources: ManagedSource[]) => {
    if (canonicalJsonString(normalizeJsonValue(sources)) !== sourceSnapshot) throw new Error('Managed sources changed during draft review');
    return sources;
  };
  const result = await initialVault.commitVaultImportTransaction(
    nextHosts, updateGroups, keepSources,
    undefined, persisted, undefined,
    async () => { assertSelected(); await options.authorizeCommit(); assertSelected(); },
  );
  if (result.status !== 'persisted') throw new Error('Vault changed before the draft was saved');
  return 'saved';
}
