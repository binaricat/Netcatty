/**
 * syncAnchorDecision — pure "has the remote changed since we last saw it?"
 * logic extracted from CloudSyncManager so it can be exercised by
 * `node --test` without standing up the full manager harness.
 *
 * Called from CloudSyncManager.inspectProviderRemoteState after the
 * remote has been downloaded and its signature computed. Given the
 * previous anchor and the current state, decides whether the remote
 * looks different enough to warrant re-merging.
 *
 * Four decisions matter for data integrity:
 *
 *   1. Anchor missing + remote empty  → not changed (first sync, nothing
 *      to merge from). Callers MUST still guard against pushing an empty
 *      local vault (see useAutoSync `hasMeaningfulSyncData`) — that guard
 *      is orthogonal to this decision.
 *   2. Anchor missing + remote non-empty → changed (first sync, remote
 *      has data we've never observed → three-way merge with empty base).
 *   3. Anchor present + resourceId drift → changed (provider created a
 *      fresh file; reuse of the old anchor would be meaningless).
 *   4. Anchor present + signature mismatch → changed (same resource, new
 *      ciphertext — standard drift).
 *
 * Any other state is "unchanged", and callers short-circuit the merge.
 *
 * @param {{
 *   currentSignature: string | null,
 *   currentResourceId: string | null,
 *   anchor: { signature?: string | null, resourceId?: string | null } | null,
 *   hasRemoteFile: boolean,
 * }} input
 * @returns {{ remoteChanged: boolean, reason: string }}
 */
export function decideRemoteChanged(input) {
  const { currentSignature, currentResourceId, anchor, hasRemoteFile } = input;

  if (!anchor) {
    // No anchor means we've never observed this provider. If remote has
    // no file at all, nothing to merge. If remote has a file, treat as
    // changed so we three-way merge (the base will be empty).
    if (!hasRemoteFile || currentSignature === null) {
      return { remoteChanged: false, reason: 'no-anchor-no-remote' };
    }
    return { remoteChanged: true, reason: 'no-anchor-remote-has-data' };
  }

  // Resource identity drift: provider returned a different resource
  // (e.g. a freshly-created gist, or the user reconnected and the
  // adapter picked a new file). The previous anchor's signature is
  // meaningless once the resource id changes.
  const anchorResourceId = anchor.resourceId ?? null;
  if (anchorResourceId !== currentResourceId) {
    return { remoteChanged: true, reason: 'resource-id-changed' };
  }

  // Same resource, different signature → new ciphertext/meta.
  if ((anchor.signature ?? null) !== currentSignature) {
    return { remoteChanged: true, reason: 'signature-mismatch' };
  }

  return { remoteChanged: false, reason: 'anchor-matches' };
}
