import type { ImporterHostDraft } from '@netcatty/plugin-contract';
import type { GroupConfig, Host, ManagedSource, Snippet } from './models';
import { applyGroupDefaults, resolveGroupDefaults } from './groupConfig';
import { hasHostConnectAutomation } from './hostConnectScripts';
import { normalizePluginImporterRecords } from './pluginImporter';
import { applyVaultHostUpdate, buildVaultHostFromDraft } from './vaultHostCreate';
import { isScriptSnippet } from './snippetScript';
import { snippetAppliesToOutputTrigger } from './snippetTargets';

// Keep the public host draft a subset of the existing typed importer. In
// particular, references to credentials, plugin configuration and executable
// settings are never accepted by this surface.
export type PluginHostDraftFields = Pick<ImporterHostDraft,
  'label' | 'hostname' | 'username' | 'port' | 'group' | 'tags'>;
export type PluginHostEditFields = Pick<PluginHostDraftFields, 'label' | 'group' | 'tags'>;

export const PLUGIN_HOST_CREATE_FIELDS = ['label', 'hostname', 'username', 'port', 'group', 'tags'] as const;
export const PLUGIN_HOST_EDIT_FIELDS = ['label', 'group', 'tags'] as const;

export function normalizePluginHostDraft(draft: PluginHostDraftFields, id: string): Host {
  const fields = Object.fromEntries(PLUGIN_HOST_CREATE_FIELDS.flatMap((field) => (
    draft[field] === undefined ? [] : [[field, draft[field]]]
  )));
  // Validate before sanitization as well: an invalid address must not become
  // a different, valid endpoint when the importer removes control characters.
  const raw = { ...fields, hostname: draft.hostname ?? '', protocol: 'ssh' as const };
  if (!buildVaultHostFromDraft(raw).ok) throw new Error('Host draft is invalid');
  const normalized = normalizePluginImporterRecords([{
    type: 'draft', draft: { kind: 'host', value: raw },
  }]);
  if (normalized.errors.length || normalized.hosts.length !== 1) {
    throw new Error('Host draft is invalid');
  }
  const validated = buildVaultHostFromDraft(normalized.hosts[0]);
  if (!validated.ok) throw new Error('Host draft is invalid');
  return { ...validated.host, id };
}

export function applyPluginHostEdit(host: Host, draft: PluginHostEditFields): Host {
  if (draft.label !== undefined && !draft.label.trim()) throw new Error('Host label is required');
  const normalized = normalizePluginHostDraft({
    label: draft.label ?? host.label,
    hostname: 'draft.invalid', username: '',
    group: draft.group ?? host.group, tags: draft.tags ?? host.tags,
  }, host.id);
  return { ...host, label: normalized.label, group: normalized.group, tags: normalized.tags };
}

export function pluginHostFieldDiff(before: Host | undefined, after: Host) {
  const fields = before ? PLUGIN_HOST_EDIT_FIELDS : PLUGIN_HOST_CREATE_FIELDS;
  return fields.flatMap((field) => {
    const previous = before?.[field];
    const value = after[field];
    return JSON.stringify(previous) === JSON.stringify(value) ? [] : [{
      field, before: previous ?? null, after: value ?? null,
    }];
  });
}

/** Managed SSH-config writes stay in the full Vault editor. Reuse its group
 * ownership rules without opening or syncing any managed file here. */
export function pluginHostDraftTouchesManagedSource(host: Host, managedSources: ManagedSource[]): boolean {
  if (host.managedSourceId) return true;
  if (managedSources.length === 0) return false;
  const reconciled = applyVaultHostUpdate([host], [], host.id, { group: host.group ?? '' }, { managedSources });
  if (!reconciled.ok) throw new Error('Host draft is invalid');
  return Boolean(reconciled.updatedHost.managedSourceId);
}

/** Only the host UI consumes this disclosure; script text never crosses RPC. */
export function pluginHostRunsSavedScripts(host: Host, groups: GroupConfig[], snippets: Snippet[]): boolean {
  const effective = applyGroupDefaults(host, host.group ? resolveGroupDefaults(host.group, groups) : {});
  return Boolean(effective.startupCommand?.trim())
    || hasHostConnectAutomation(effective, snippets)
    || snippets.some((snippet) => isScriptSnippet(snippet) && snippetAppliesToOutputTrigger(snippet, effective))
    || Boolean(effective.outputTriggers?.length);
}
