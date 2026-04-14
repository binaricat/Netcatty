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

test('no anchor + hasRemoteFile true but null signature → changed (unreadable remote, C3)', () => {
  // Previously this returned `remoteChanged: false`, which silently
  // routed callers down the "nothing to merge" short-circuit and then
  // let the upload path stomp the malformed-but-extant remote file on
  // the next push. Treating an unreadable remote as "changed" forces the
  // three-way-merge branch — if the payload is decryptable the merge
  // succeeds, and if it isn't the decrypt error surfaces to the user
  // instead of being silently papered over by an overwrite.
  const result = decideRemoteChanged({
    currentSignature: null,
    currentResourceId: 'gist-1',
    anchor: null,
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'unreadable-remote');
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

// -----------------------------------------------------------------------
// Migration: stored v2 anchor → fresh v3 signature from this build
// -----------------------------------------------------------------------

test('v2 anchor persisted from older build → signature-mismatch against v3 (migration)', () => {
  // A user upgrading from a build that persisted `v2:<prefix-hash>` must
  // see the next startup inspection treat the remote as "changed". The
  // v3 signature format is `v3:{...meta}|len=...|sha256=...`; the two
  // strings can never compare equal, so the decision routes through
  // three-way merge and re-observes the remote. Without this property
  // a stale v2 anchor would be treated as authoritative, skipping the
  // merge and letting local-only state overwrite remote — the very
  // #711/#719 failure path.
  const result = decideRemoteChanged({
    currentSignature: 'v3:{"appVersion":"1.0.0"}|len=80|sha256=' + 'a'.repeat(64),
    currentResourceId: 'gist-1',
    anchor: { signature: 'v2:abcdef1234567890', resourceId: 'gist-1' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'signature-mismatch');
});

// -----------------------------------------------------------------------
// Regression: issues #711 / #719 — stale-device-overwrites-newer-remote
// -----------------------------------------------------------------------

test('stale device sees fresh remote → triggers merge, not overwrite (#711/#719)', () => {
  // Scenario: Device A syncs at T0, anchor records signature sigA.
  // User edits on Device B at T1 → remote signature becomes sigB.
  // Device A then wakes up with a stale anchor (sigA) and the fresh
  // remote (sigB). The decision MUST say "remote changed" so the
  // sync path three-way merges Device A's local into remote instead
  // of short-circuiting to "no change" and overwriting Device B's edit.
  const sigA = 'v3:{"updatedAt":1700000000000}|len=80|sha256=' + 'a'.repeat(64);
  const sigB = 'v3:{"updatedAt":1700000300000}|len=80|sha256=' + 'b'.repeat(64);
  const result = decideRemoteChanged({
    currentSignature: sigB,
    currentResourceId: 'gist-1',
    anchor: { signature: sigA, resourceId: 'gist-1' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, true);
  assert.equal(result.reason, 'signature-mismatch');
});

test('fresh device, same-signature anchor → no spurious merge (#711/#719 inverse)', () => {
  // Inverse guard: a device whose anchor matches the current remote
  // signature must NOT be dragged through a merge round-trip, which
  // would cause the "everyone re-uploads on every startup" thrash seen
  // in the pre-anchor implementation. This locks in that the anchor
  // logic correctly short-circuits the common case.
  const sig = 'v3:{"updatedAt":1700000000000}|len=80|sha256=' + 'a'.repeat(64);
  const result = decideRemoteChanged({
    currentSignature: sig,
    currentResourceId: 'gist-1',
    anchor: { signature: sig, resourceId: 'gist-1' },
    hasRemoteFile: true,
  });
  assert.equal(result.remoteChanged, false);
  assert.equal(result.reason, 'anchor-matches');
});
