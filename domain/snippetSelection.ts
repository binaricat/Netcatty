import type { Host, Snippet } from './models';
import { deleteSnippetFromVault } from './snippetAgentOps.ts';
import { renumberVaultOrder } from './vaultOrder.ts';

/** Normalize `netcatty:snippets:delete` detail into a set of snippet ids. */
export function collectSnippetDeleteIds(
  detail?: { id?: string; ids?: readonly string[] } | null,
): Set<string> {
  const ids = new Set<string>();
  for (const id of detail?.ids ?? []) {
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  if (typeof detail?.id === 'string' && detail.id.length > 0) {
    ids.add(detail.id);
  }
  return ids;
}

export function deleteSelectedSnippetsFromVault(
  snippets: Snippet[],
  hosts: Host[],
  selectedSnippetIds: ReadonlySet<string>,
): { snippets: Snippet[]; hosts: Host[]; deletedCount: number } {
  let nextSnippets = [...snippets];
  let nextHosts = [...hosts];
  let deletedCount = 0;

  for (const snippet of snippets) {
    if (!snippet.id || !selectedSnippetIds.has(snippet.id)) continue;
    const result = deleteSnippetFromVault(nextSnippets, nextHosts, snippet.id);
    if ('error' in result) continue;
    nextSnippets = result.snippets;
    nextHosts = result.hosts;
    deletedCount += 1;
  }

  return { snippets: nextSnippets, hosts: nextHosts, deletedCount };
}

/**
 * Drop login/connect script bindings that point at snippets absent from the
 * latest catalog. A queued full-array host write that encrypted before a
 * concurrent bulk-delete must not restore those bindings after the delete
 * releases the vault lock.
 */
export function pruneStaleHostSnippetBindings(
  host: Host,
  snippetIds: ReadonlySet<string>,
): Host {
  let next = host;
  if (host.loginScriptId && !snippetIds.has(host.loginScriptId)) {
    next = { ...next, loginScriptId: undefined };
  }
  const connectIds = next.connectScriptIds;
  if (connectIds?.length) {
    const pruned = connectIds.filter((id) => Boolean(id) && snippetIds.has(id));
    if (
      pruned.length !== connectIds.length
      || pruned.some((id, index) => id !== connectIds[index])
    ) {
      next = {
        ...next,
        connectScriptIds: pruned.length > 0 ? pruned : undefined,
      };
    }
  }
  return next;
}

/** Returns `hosts` unchanged when every binding still resolves. */
export function pruneHostsStaleSnippetBindings(
  hosts: readonly Host[],
  snippets: readonly Snippet[],
): Host[] {
  const snippetIds = new Set<string>();
  for (const snippet of snippets) {
    if (snippet.id) snippetIds.add(snippet.id);
  }
  let changed = false;
  const next = hosts.map((host) => {
    const pruned = pruneStaleHostSnippetBindings(host, snippetIds);
    if (pruned !== host) changed = true;
    return pruned;
  });
  return changed ? next : (hosts as Host[]);
}

/**
 * Content fingerprint for three-way rebase. Omits `order` so a local reorder
 * (which renumbers every row) does not look like an edit of unrelated snippets.
 */
function snippetContentFingerprint(snippet: Snippet): string {
  const { order: _order, ...content } = snippet;
  return JSON.stringify(content, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (value as Record<string, unknown>)[key];
        return acc;
      }, {});
    }
    return value;
  });
}

/** Relative id sequence for ids present on both sides (order-change detector). */
function sharedIdSequence(
  snippets: readonly Snippet[],
  sharedIds: ReadonlySet<string>,
): string[] {
  const sequence: string[] = [];
  for (const snippet of snippets) {
    if (!snippet.id || !sharedIds.has(snippet.id)) continue;
    sequence.push(snippet.id);
  }
  return sequence;
}

function sameIdSequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function applyPreferredOrder(
  content: Snippet,
  ourItem: Snippet,
  theirItem: Snippet,
  preferTheirSharedOrder: boolean,
): Snippet {
  const order = preferTheirSharedOrder ? theirItem.order : ourItem.order;
  return content.order === order ? content : { ...content, order };
}

/**
 * Place ids that are new relative to `baseIds` into `result`, preserving each
 * side's insertion anchors (between left/right neighbors already present).
 * A trailing insertion (no right neighbor) appends so a local add stays at the
 * end after an unrelated disk reorder of shared ids.
 */
function placeInsertions(
  result: string[],
  side: readonly Snippet[],
  baseIds: ReadonlySet<string>,
  keep: ReadonlyMap<string, Snippet>,
): void {
  const present = new Set(result);
  for (let index = 0; index < side.length; index += 1) {
    const id = side[index]?.id;
    if (!id || !keep.has(id) || baseIds.has(id) || present.has(id)) continue;

    let left: string | null = null;
    for (let j = index - 1; j >= 0; j -= 1) {
      const prev = side[j]?.id;
      if (prev && present.has(prev)) {
        left = prev;
        break;
      }
    }
    let right: string | null = null;
    for (let j = index + 1; j < side.length; j += 1) {
      const next = side[j]?.id;
      if (next && present.has(next)) {
        right = next;
        break;
      }
    }

    if (right === null) {
      result.push(id);
    } else if (left === null) {
      result.splice(result.indexOf(right), 0, id);
    } else {
      const leftIdx = result.indexOf(left);
      const rightIdx = result.indexOf(right);
      if (leftIdx < rightIdx) {
        result.splice(rightIdx, 0, id);
      } else {
        result.splice(leftIdx + 1, 0, id);
      }
    }
    present.add(id);
  }
}

/**
 * Three-way rebase for a queued full-array snippet save against the latest
 * persisted vault snapshot.
 *
 * Unlike sync merge, a concurrent disk delete always wins over a local edit of
 * the same id so bulk-delete cannot be resurrected by a stale window write.
 * When an id exists on all sides, preserve a disk-only content edit; both-sides
 * content conflicts prefer the local write (same as sync merge).
 * List order is merged independently: shared-id reorder picks a backbone, then
 * each side's insertions are placed by their own anchors so a local append does
 * not discard a remote mid-list insertion (and the reverse).
 */
export function rebaseSnippetVaultWrite({
  base,
  ours,
  theirs,
}: {
  base: readonly Snippet[];
  ours: readonly Snippet[];
  theirs: readonly Snippet[];
}): Snippet[] {
  const baseMap = new Map(base.map((snippet) => [snippet.id, snippet]));
  const oursMap = new Map(ours.map((snippet) => [snippet.id, snippet]));
  const theirsMap = new Map(theirs.map((snippet) => [snippet.id, snippet]));
  const keep = new Map<string, Snippet>();

  const allIds = new Set<string>([
    ...baseMap.keys(),
    ...oursMap.keys(),
    ...theirsMap.keys(),
  ]);

  const baseIds = new Set<string>();
  const baseOursIds = new Set<string>();
  const baseTheirsIds = new Set<string>();
  for (const id of baseMap.keys()) {
    if (!id) continue;
    baseIds.add(id);
    if (oursMap.has(id)) baseOursIds.add(id);
    if (theirsMap.has(id)) baseTheirsIds.add(id);
  }
  // Shared-id sequences ignore insertions. Detect reorder of existing ids
  // separately from new-id placement so a local add does not look like a
  // reorder that discards an unrelated disk reorder.
  const oursSharedReordered = !sameIdSequence(
    sharedIdSequence(base, baseOursIds),
    sharedIdSequence(ours, baseOursIds),
  );
  const theirsSharedReordered = !sameIdSequence(
    sharedIdSequence(base, baseTheirsIds),
    sharedIdSequence(theirs, baseTheirsIds),
  );
  // Backbone follows disk only for a disk-only shared reorder. Insertions are
  // merged by anchor below — not by picking one side's entire list order.
  const preferTheirSharedOrder = !oursSharedReordered && theirsSharedReordered;

  for (const id of allIds) {
    if (!id) continue;
    const baseItem = baseMap.get(id);
    const ourItem = oursMap.get(id);
    const theirItem = theirsMap.get(id);
    const inBase = baseItem !== undefined;
    const inOurs = ourItem !== undefined;
    const inTheirs = theirItem !== undefined;

    if (!inBase && inOurs && !inTheirs) {
      keep.set(id, ourItem);
      continue;
    }
    if (!inBase && !inOurs && inTheirs) {
      keep.set(id, theirItem);
      continue;
    }
    if (!inBase && inOurs && inTheirs) {
      keep.set(id, ourItem);
      continue;
    }
    if (inBase && inOurs && inTheirs) {
      const oursChanged =
        snippetContentFingerprint(ourItem) !== snippetContentFingerprint(baseItem);
      const theirsChanged =
        snippetContentFingerprint(theirItem) !== snippetContentFingerprint(baseItem);
      if (!oursChanged && theirsChanged) {
        // Disk-only content edit: keep their body; order follows shared reorder.
        keep.set(
          id,
          applyPreferredOrder(theirItem, ourItem, theirItem, preferTheirSharedOrder),
        );
      } else {
        // Unchanged, ours-only, or both-changed conflict → local content wins.
        keep.set(
          id,
          applyPreferredOrder(ourItem, ourItem, theirItem, preferTheirSharedOrder),
        );
      }
      continue;
    }
    // Local delete (even if disk still has / edited the row).
    if (inBase && !inOurs && inTheirs) continue;
    // Concurrent disk delete — do not resurrect from a stale local edit.
    if (inBase && inOurs && !inTheirs) continue;
  }

  const backboneSide = preferTheirSharedOrder ? theirs : ours;
  const secondarySide = preferTheirSharedOrder ? ours : theirs;
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const snippet of backboneSide) {
    const id = snippet.id;
    if (!id || !keep.has(id) || !baseIds.has(id) || seen.has(id)) continue;
    orderedIds.push(id);
    seen.add(id);
  }
  // Place primary then secondary insertions so each side keeps its anchors.
  placeInsertions(orderedIds, backboneSide, baseIds, keep);
  placeInsertions(orderedIds, secondarySide, baseIds, keep);

  const ordered: Snippet[] = [];
  for (const id of orderedIds) {
    const kept = keep.get(id);
    if (!kept) continue;
    ordered.push(kept);
  }
  // Anchored merge can leave duplicate finite `order` values (e.g. remote
  // insertion X at 2000 while local B still has 2000). normalizeVaultOrder
  // preserves finite orders, so renumber to match the merged sequence.
  return renumberVaultOrder(ordered);
}
