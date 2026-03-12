/**
 * Sync Payload Builders — Single source of truth for constructing and applying
 * the encrypted cloud-sync payload.
 *
 * Both the main window (App.tsx) and the settings window (SettingsSyncTab.tsx)
 * must use these helpers to guarantee every field is included and no data is
 * silently dropped.
 */

import type {
  Host,
  Identity,
  KnownHost,
  PortForwardingRule,
  Snippet,
  SSHKey,
} from './models';
import type { SyncPayload } from './sync';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** All vault-owned data that participates in cloud sync. */
export interface SyncableVaultData {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  customGroups: string[];
  snippetPackages?: string[];
  knownHosts: KnownHost[];
}

/** Callbacks used by `applySyncPayload` to import data into local state. */
export interface SyncPayloadImporters {
  /** Import vault data (hosts, keys, identities, snippets, customGroups, snippetPackages, knownHosts). */
  importVaultData: (jsonString: string) => void;
  /** Import port-forwarding rules (lives outside the vault hook). */
  importPortForwardingRules?: (rules: PortForwardingRule[]) => void;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a complete `SyncPayload` from local data.
 *
 * Port-forwarding rules are optional because they are managed by a separate
 * state hook (`usePortForwardingState`).  Callers should strip transient
 * runtime fields (status, error, lastUsedAt) before passing them in.
 */
export function buildSyncPayload(
  vault: SyncableVaultData,
  portForwardingRules?: PortForwardingRule[],
): SyncPayload {
  return {
    hosts: vault.hosts,
    keys: vault.keys,
    identities: vault.identities,
    snippets: vault.snippets,
    customGroups: vault.customGroups,
    snippetPackages: vault.snippetPackages,
    knownHosts: vault.knownHosts,
    portForwardingRules,
    syncedAt: Date.now(),
  };
}

/**
 * Apply a downloaded `SyncPayload` to local state via the provided importers.
 *
 * This ensures both vault data and port-forwarding rules are imported
 * consistently across windows.
 */
export function applySyncPayload(
  payload: SyncPayload,
  importers: SyncPayloadImporters,
): void {
  // Build the vault import object.  knownHosts is only included when the
  // payload explicitly carries the field (even if it's []).  Legacy cloud
  // snapshots may omit it entirely — in that case we leave the local
  // known-hosts list untouched rather than destructively wiping it.
  const vaultImport: Record<string, unknown> = {
    hosts: payload.hosts,
    keys: payload.keys,
    identities: payload.identities,
    snippets: payload.snippets,
    customGroups: payload.customGroups,
  };
  if (payload.snippetPackages !== undefined) {
    vaultImport.snippetPackages = payload.snippetPackages;
  }
  if (payload.knownHosts !== undefined) {
    vaultImport.knownHosts = payload.knownHosts;
  }

  importers.importVaultData(JSON.stringify(vaultImport));

  // Only import port-forwarding rules when the payload explicitly carries
  // them.  Absent field = "payload was created before this feature existed",
  // so local rules are preserved.  Explicitly present [] = "remote has no
  // rules, clear local state".
  if (payload.portForwardingRules !== undefined && importers.importPortForwardingRules) {
    importers.importPortForwardingRules(payload.portForwardingRules);
  }
}
