import type { Host, Snippet } from './models';
import { isScriptSnippet } from './snippetScript.ts';
import {
  getScriptsLinkedToHost,
  linkHostToScript,
  snippetAppliesToHost,
  unlinkHostFromScripts,
} from './snippetTargets.ts';
import { sortByVaultOrder } from './vaultOrder.ts';

function isOnConnectScript(snippet: Snippet): boolean {
  return isScriptSnippet(snippet) && snippet.trigger === 'onConnect' && Boolean(snippet.id);
}

function scriptById(snippets: Snippet[], scriptId: string): Snippet | undefined {
  return snippets.find((snippet) => snippet.id === scriptId && isScriptSnippet(snippet));
}

function pruneConnectScriptIds(ids: string[], snippets: Snippet[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    const snippet = scriptById(snippets, id);
    if (!snippet || !isOnConnectScript(snippet)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Draft/edit queue prune: keep any existing script IDs.
 * Host save promotes non-onConnect scripts via prepareSnippetForHostConnectQueue.
 */
function pruneEditableConnectScriptIds(ids: string[], snippets: Snippet[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    const snippet = scriptById(snippets, id);
    if (!snippet) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Global onConnect scripts (targetsAllHosts), sorted by vault order. */
export function getGlobalConnectScripts(snippets: Snippet[]): Snippet[] {
  return sortByVaultOrder(
    snippets.filter(
      (snippet) => isOnConnectScript(snippet) && Boolean(snippet.targetsAllHosts),
    ),
  );
}

/** Derive initial connectScriptIds from legacy host + snippet bindings. */
export function migrateHostConnectScriptIds(host: Host, snippets: Snippet[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (scriptId?: string) => {
    if (!scriptId || seen.has(scriptId)) return;
    const snippet = scriptById(snippets, scriptId);
    if (!snippet || !isOnConnectScript(snippet)) return;
    if (!snippetAppliesToHost(snippet, host.id) && !snippet.targetsAllHosts) return;
    seen.add(scriptId);
    ordered.push(scriptId);
  };

  push(host.loginScriptId);

  for (const snippet of getScriptsLinkedToHost(snippets, host.id)) {
    if (snippet.trigger === 'onConnect') {
      push(snippet.id);
    }
  }

  for (const snippet of sortByVaultOrder(snippets)) {
    if (!isOnConnectScript(snippet)) continue;
    if (snippet.targetsAllHosts) continue;
    if (!snippetAppliesToHost(snippet, host.id)) continue;
    push(snippet.id);
  }

  return ordered;
}

/** Effective ordered script IDs for a host (lazy migrate + prune). */
export function getHostConnectScriptIds(host: Host, snippets: Snippet[]): string[] {
  if (host.connectScriptIds !== undefined) {
    return pruneConnectScriptIds(host.connectScriptIds, snippets);
  }
  return migrateHostConnectScriptIds(host, snippets);
}

/**
 * Host-details draft queue: includes scripts pending promote-to-onConnect on save.
 * Runtime connect still uses getHostConnectScriptIds (onConnect only).
 */
export function getEditableHostConnectScriptIds(host: Host, snippets: Snippet[]): string[] {
  if (host.connectScriptIds !== undefined) {
    return pruneEditableConnectScriptIds(host.connectScriptIds, snippets);
  }
  return migrateHostConnectScriptIds(host, snippets);
}

export function ensureHostConnectScriptIds(host: Host, snippets: Snippet[]): Host {
  if (host.connectScriptIds !== undefined) {
    const pruned = pruneEditableConnectScriptIds(host.connectScriptIds, snippets);
    if (pruned.length === host.connectScriptIds.length
      && pruned.every((id, index) => id === host.connectScriptIds![index])) {
      return host;
    }
    return { ...host, connectScriptIds: pruned };
  }
  const migrated = migrateHostConnectScriptIds(host, snippets);
  return migrated.length > 0 ? { ...host, connectScriptIds: migrated } : host;
}

/** True when host references connect scripts that are not present in snippets yet. */
export function hasUnresolvedConnectScriptBindings(host: Host, snippets: Snippet[]): boolean {
  const candidateIds = new Set<string>();
  if (host.loginScriptId) candidateIds.add(host.loginScriptId);
  for (const id of host.connectScriptIds ?? []) {
    if (id) candidateIds.add(id);
  }
  for (const id of candidateIds) {
    if (!snippets.some((snippet) => snippet.id === id)) {
      return true;
    }
  }
  return false;
}

/** Resolve full onConnect run list: global scripts first, then host queue; dedupe favors host queue. */
export function resolveConnectScriptsForHost(host: Host, snippets: Snippet[]): Snippet[] {
  const hostIds = getHostConnectScriptIds(host, snippets);
  const hostIdSet = new Set(hostIds);
  const globals = getGlobalConnectScripts(snippets).filter(
    (snippet) => snippet.id && !hostIdSet.has(snippet.id),
  );
  const hostScripts = hostIds
    .map((id) => scriptById(snippets, id))
    .filter((snippet): snippet is Snippet => Boolean(snippet));
  return [...globals, ...hostScripts];
}

/**
 * Whether connecting this host can run automation that depends on the initial
 * login output. Missing referenced scripts still count: vault hydration or a
 * later sync may restore them after the terminal has already started.
 */
export function hasHostConnectAutomation(host: Host, snippets: Snippet[]): boolean {
  return hasUnresolvedConnectScriptBindings(host, snippets)
    || resolveConnectScriptsForHost(host, snippets).length > 0;
}

export function shouldUseFreshSshConnectionForAutomation(options: {
  host: Host;
  snippets: Snippet[];
  vaultInitialized: boolean;
  hasPendingScript?: boolean;
  connectAutomationConsumed?: boolean;
}): boolean {
  return options.hasPendingScript === true
    || (
      options.connectAutomationConsumed !== true
      && (
        !options.vaultInitialized
        || hasHostConnectAutomation(options.host, options.snippets)
      )
    );
}

/**
 * Mark the current connection's automation decision as final once the vault
 * has hydrated, even when it hydrated to an empty script list. This prevents a
 * later sync from starting a newly arrived global script against a connection
 * whose initial login output may already have been skipped.
 */
export function shouldMarkConnectAutomationConsumed(options: {
  allConnectScriptsDone: boolean;
  vaultInitialized: boolean;
  hasUnresolvedBindings: boolean;
}): boolean {
  return options.allConnectScriptsDone
    && options.vaultInitialized
    && !options.hasUnresolvedBindings;
}

export function appendHostConnectScript(host: Host, scriptId: string, snippets: Snippet[]): Host {
  const snippet = scriptById(snippets, scriptId);
  if (!snippet) return host;
  const current = getEditableHostConnectScriptIds(host, snippets);
  if (current.includes(scriptId)) {
    return { ...host, connectScriptIds: current };
  }
  return { ...host, connectScriptIds: [...current, scriptId] };
}

export function removeHostConnectScript(host: Host, scriptId: string, snippets: Snippet[]): Host {
  const current = getEditableHostConnectScriptIds(host, snippets);
  const next = current.filter((id) => id !== scriptId);
  return { ...host, connectScriptIds: next };
}

export function reorderHostConnectScript(
  host: Host,
  draggedScriptId: string,
  targetScriptId: string,
  position: 'before' | 'after',
  snippets: Snippet[],
): Host {
  if (draggedScriptId === targetScriptId) return host;
  const current = [...getEditableHostConnectScriptIds(host, snippets)];
  const fromIndex = current.indexOf(draggedScriptId);
  const targetIndex = current.indexOf(targetScriptId);
  if (fromIndex === -1 || targetIndex === -1) return host;

  current.splice(fromIndex, 1);
  let insertIndex = current.indexOf(targetScriptId);
  if (insertIndex === -1) return host;
  if (position === 'after') insertIndex += 1;
  current.splice(insertIndex, 0, draggedScriptId);
  return { ...host, connectScriptIds: current };
}

export function prepareSnippetForHostConnectQueue(snippet: Snippet, hostId: string): Snippet {
  if (!isScriptSnippet(snippet)) return snippet;
  return {
    ...linkHostToScript(snippet, hostId),
    trigger: 'onConnect',
  };
}

function connectQueueSnippetNeedsPromote(snippet: Snippet, hostId: string): boolean {
  if (!isScriptSnippet(snippet)) return false;
  // Never demote vault-wide onConnect scripts just because they appear in a host queue.
  if (snippet.targetsAllHosts) return false;
  if (snippet.trigger !== 'onConnect') return true;
  return !snippetAppliesToHost(snippet, hostId);
}

/**
 * Sync script metadata when saving a host connect queue.
 * Promotes every queued script to onConnect + host target, including IDs that
 * were already persisted as draft/manual entries before this save.
 */
export function syncSnippetsForHostConnectQueueSave(
  snippets: Snippet[],
  hostId: string,
  previousQueueIds: string[],
  nextQueueIds: string[],
): { snippets: Snippet[]; changed: boolean } {
  const nextSet = new Set(nextQueueIds);
  let nextSnippets = snippets;
  let changed = false;

  for (const scriptId of nextQueueIds) {
    nextSnippets = nextSnippets.map((item) => {
      if (item.id !== scriptId || !isScriptSnippet(item)) return item;
      if (!connectQueueSnippetNeedsPromote(item, hostId)) return item;
      changed = true;
      return prepareSnippetForHostConnectQueue(item, hostId);
    });
  }

  for (const scriptId of previousQueueIds) {
    if (nextSet.has(scriptId)) continue;
    const unlinked = unlinkHostFromScripts(nextSnippets, hostId, scriptId);
    if (unlinked !== nextSnippets) {
      nextSnippets = unlinked;
      changed = true;
    }
  }

  return { snippets: nextSnippets, changed };
}

export function syncHostsForSnippetTargetChange(
  hosts: Host[],
  snippet: Snippet,
  prevTargetIds: string[] | undefined,
  snippets: Snippet[],
): Host[] {
  if (!isScriptSnippet(snippet) || snippet.trigger !== 'onConnect' || !snippet.id) {
    return hosts;
  }
  if (snippet.targetsAllHosts) {
    return hosts.map((host) => removeHostConnectScript(host, snippet.id!, snippets));
  }

  const prev = new Set(prevTargetIds ?? []);
  const next = new Set(snippet.targets ?? []);
  const added = [...next].filter((id) => !prev.has(id));
  const removed = [...prev].filter((id) => !next.has(id));
  if (added.length === 0 && removed.length === 0) return hosts;

  return hosts.map((host) => {
    let updated = host;
    if (added.includes(host.id)) {
      updated = appendHostConnectScript(updated, snippet.id!, snippets);
    }
    if (removed.includes(host.id)) {
      updated = removeHostConnectScript(updated, snippet.id!, snippets);
    }
    return updated;
  });
}
