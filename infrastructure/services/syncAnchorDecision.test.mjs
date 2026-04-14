import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRemoteChanged } from './syncAnchorDecision.js';

// -----------------------------------------------------------------------
// Anchor-missing branches
// -----------------------------------------------------------------------

test('no anchor + empty remote → not changed (first sync with empty cloud)', () => {
  const result = decideRemoteChanged({
    currentSignature: null,
    currentResourceId: null,
    anchor: null,
    hasRemoteFile: false,
  });
  assert.equal(result.remoteChanged, false);
  assert.equal(result.reason, 'no-anchor-no-remote');
});

test('no anchor + non-empty remote → changed (first sync with data in cloud)', () => {
  // Critical: this is the "new device with existing cloud vault" path.
  // Returning not-changed here would silently skip the three-way merge
  // and let an empty local push clobber remote.
  const result = decideRemoteChanged({
    currentSignature: 'v3:sig-remote',
    currentResourceId: 'gist-1',
    anchor: null,
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'no-anchor-remote-has-data');
});

test('no anchor + hasRemoteFile true but null signature → not changed (defensive)', () => {
  // Defensive shape: if the adapter returns a truthy remoteFile but the
  // signature somehow computes to null (malformed meta), we must NOT
  // treat it as "remote has data" because we have no way to three-way
  // merge against it anyway.
  const result = decideRemoteChanged({
    currentSignature: null,
    currentResourceId: 'gist-1',
    anchor: null,
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, false);
});

// -----------------------------------------------------------------------
// Anchor-matches branches
// -----------------------------------------------------------------------

test('anchor matches signature and resourceId → not changed', () => {
  const result = decideRemoteChanged({
    currentSignature: 'v3:sig-A',
    currentResourceId: 'gist-1',
    anchor: { signature: 'v3:sig-A', resourceId: 'gist-1' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, false);
  assert.equal(result.reason, 'anchor-matches');
});

// -----------------------------------------------------------------------
// Anchor-stale branches
// -----------------------------------------------------------------------

test('anchor signature mismatch → changed', () => {
  const result = decideRemoteChanged({
    currentSignature: 'v3:sig-NEW',
    currentResourceId: 'gist-1',
    anchor: { signature: 'v3:sig-OLD', resourceId: 'gist-1' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'signature-mismatch');
});

test('anchor resourceId mismatch → changed (even when signatures happen to match)', () => {
  // Provider created a fresh file (gist recreated, Drive file recreated).
  // The old anchor's signature is meaningless once the resource id drifts.
  const result = decideRemoteChanged({
    currentSignature: 'v3:sig-SAME',
    currentResourceId: 'gist-NEW',
    anchor: { signature: 'v3:sig-SAME', resourceId: 'gist-OLD' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'resource-id-changed');
});

test('anchor resourceId was null, now has value → changed', () => {
  // Before: user connected but first-sync had no resource yet.
  // Now: provider returned a concrete id. Treat as changed so the
  // follow-up re-inspects correctly.
  const result = decideRemoteChanged({
    currentSignature: 'v3:sig-A',
    currentResourceId: 'gist-1',
    anchor: { signature: 'v3:sig-A', resourceId: null },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'resource-id-changed');
});

test('anchor resourceId had value, now null → changed', () => {
  // Adapter lost the resource id somehow (disconnect, re-login). The
  // old signature-based comparison is not trustworthy here.
  const result = decideRemoteChanged({
    currentSignature: 'v3:sig-A',
    currentResourceId: null,
    anchor: { signature: 'v3:sig-A', resourceId: 'gist-1' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'resource-id-changed');
});

// -----------------------------------------------------------------------
// Defensive shapes
// -----------------------------------------------------------------------

test('anchor with undefined signature → changed unless current is also null', () => {
  // `anchor.signature` missing (pre-v2 persisted record, say) and
  // `currentSignature` non-null → must not treat as match.
  const changed = decideRemoteChanged({
    currentSignature: 'v3:sig',
    currentResourceId: 'id-1',
    anchor: { resourceId: 'id-1' },
    hasRemoteFile: true,
  });
  assert.equal(changed.remoteChanged, true);
  assert.equal(changed.reason, 'signature-mismatch');
});

test('anchor signature null and current signature null with same resourceId → not changed', () => {
  // The legitimate "empty-on-both-sides already observed" case.
  const result = decideRemoteChanged({
    currentSignature: null,
    currentResourceId: 'id-1',
    anchor: { signature: null, resourceId: 'id-1' },
    hasRemoteFile: false,
  });
  assert.equal(result.remoteChanged, false);
  assert.equal(result.reason, 'anchor-matches');
});
