import type { Host, Snippet } from './models';
import { isScriptSnippet } from './snippetScript.ts';

/** Whether the snippet has a runnable scope (explicit targets or all-hosts flag). */
export function snippetHasRunTargets(snippet: Pick<Snippet, 'targets' | 'targetsAllHosts'>): boolean {
  if (snippet.targetsAllHosts) return true;
  return Boolean(snippet.targets && snippet.targets.length > 0);
}

/** Connectable hosts for manual run / save-and-run. */
export function getRunnableHostsForSnippet(
  snippet: Pick<Snippet, 'targets' | 'targetsAllHosts'>,
  hosts: Host[],
): Host[] {
  const connectable = hosts.filter((host) => host.protocol !== 'serial');
  if (snippet.targetsAllHosts) return connectable;
  const idSet = new Set(snippet.targets ?? []);
  return connectable.filter((host) => idSet.has(host.id));
}

/** Whether a snippet/script applies to the given host based on targets or all-hosts flag. */
export function snippetAppliesToHost(snippet: Snippet, hostId?: string): boolean {
  if (hostId === undefined) return false;
  if (snippet.targetsAllHosts) return true;
  if (!snippet.targets || snippet.targets.length === 0) return false;
  return snippet.targets.includes(hostId);
}

/**
 * onOutput triggers listen on the active terminal session. When no explicit targets
 * are configured, they apply to whichever host the session is connected to.
 */
export function snippetAppliesToOutputTrigger(
  snippet: Pick<Snippet, 'trigger' | 'targets' | 'targetsAllHosts'>,
  hostId?: string,
): boolean {
  if (snippet.trigger !== 'onOutput') return false;
  if (hostId === undefined) return false;
  if (snippet.targetsAllHosts) return true;
  if (snippet.targets && snippet.targets.length > 0) {
    return snippet.targets.includes(hostId);
  }
  return true;
}

/** Scripts explicitly linked to a host via targets (excludes all-hosts scripts). */
export function getScriptsLinkedToHost(snippets: Snippet[], hostId: string): Snippet[] {
  return snippets.filter(
    (snippet) => isScriptSnippet(snippet)
      && !snippet.targetsAllHosts
      && Boolean(snippet.targets?.includes(hostId)),
  );
}

export function linkHostToScript(snippet: Snippet, hostId: string): Snippet {
  const targets = snippet.targets ?? [];
  if (targets.includes(hostId)) {
    return { ...snippet, targetsAllHosts: undefined };
  }
  return {
    ...snippet,
    targets: [...targets, hostId],
    targetsAllHosts: undefined,
  };
}

export function unlinkHostFromScript(snippet: Snippet, hostId: string): Snippet {
  const targets = snippet.targets ?? [];
  if (!targets.includes(hostId)) return snippet;
  const nextTargets = targets.filter((id) => id !== hostId);
  return { ...snippet, targets: nextTargets.length > 0 ? nextTargets : undefined };
}

export function unlinkHostFromScripts(snippets: Snippet[], hostId: string, scriptId: string): Snippet[] {
  return snippets.map((snippet) => (
    snippet.id === scriptId ? unlinkHostFromScript(snippet, hostId) : snippet
  ));
}
