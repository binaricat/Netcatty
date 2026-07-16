# Convergent Sync CRDT Core

Status: experimental core; not connected to persistence or cloud providers yet.

Issue: [#2245](https://github.com/binaricat/Netcatty/issues/2245)

## Goal

The existing sync engine compares local and remote snapshots against a stored
base. That is useful for two replicas, but folding more replicas or providers in
different orders is not algebraically safe. The v2 core defines a state-based
join so every replica reaches the same state regardless of message order,
duplication, or grouping.

This first change intentionally contains only pure domain logic. Encryption,
legacy migration, provider verification, persistence, and UI are separate
follow-up changes after this core is reviewed.

Mutation callers must provide the wall-clock sample used to advance the HLC.
The domain layer never reads `Date.now()`, so replaying the same state, device,
mutation batch, and timestamp produces identical serialized state.

## State model

Each device owns a monotonically increasing counter. A write allocates a unique
dot `(deviceId, counter)`. The global version vector allocates collision-free
dots, while each candidate records the exact prior dots observed in its own
register. The register context is an exact dot set rather than another compact
version vector because one device's global counters can interleave writes to
different registers. A Hybrid Logical Clock (HLC) supplies a user-facing
ordering hint without defining causality.

The replica contains:

- one global dotted version vector and HLC;
- a compact dot-origin index mapping every device counter to its register;
- an MV-register for entity presence;
- an MV-register for collection position;
- an MV-register for every top-level entity field;
- an MV-register for every settings leaf path (arrays are atomic leaves);
- observed-remove string entries with their own presence and position
  registers.

A string-entry remove is emitted only after the replica has observed a currently
visible add. Deleting a locally absent entry is a no-op, so a concurrent add on
another replica survives without creating an artificial value/tombstone conflict.

Mutation application is idempotent for already-selected entity fields, string
entries, and settings. A same-value settings write still tombstones active
ancestor or descendant paths, and a same-value write against an MV-register
conflict still emits a causally dominating resolution.

A full entity upsert follows the same rule for presence, fields, and collection
position: unchanged conflict-free registers are preserved, while accepting a
currently selected conflicted value emits a new candidate that dominates every
retained alternative.

String-entry add mutations likewise resolve visible presence and position
conflicts even when the selected values are unchanged; conflict-free repeated
adds remain no-ops.

Deletion is a register candidate, not absence from the serialized structure.
Tombstones are retained indefinitely in v2. A later recreation replaces a
tombstone only when its new dot causally observes the deletion.

Settings writes keep the active leaf set prefix-free. Replacing an object leaf
with an atomic parent (or the reverse) causally tombstones the overlapping
paths. Deleting a settings path tombstones that path and every causally observed
descendant, so deleting a subtree cannot leave stale leaf registers visible;
deleting a nested path does not implicitly remove an atomic ancestor.
Independent replicas can still create a parent/descendant shape conflict;
materialization then selects a deterministic maximal prefix-free set, keeps
non-overlapping siblings, and reports the competing paths and candidates for
explicit resolution.

Entity field updates also write a fresh present candidate. Consequently, an
offline deletion racing an offline edit becomes a presence conflict; it cannot
silently hide the edit. No-op field writes allocate no dot and do not refresh
presence. Deleting a field from a non-present entity may tombstone stale field
data but never recreates the entity.

## Join

For each register, the join keeps:

1. candidates present on both sides;
2. left-only candidates not covered by the right register's causal context;
3. right-only candidates not covered by the left register's causal context.

Candidates causally dominated by another surviving candidate are removed. The
replica vector is the pointwise maximum. A global vector is never used as proof
that a candidate from an absent register was superseded; only a candidate in
that same register can carry such proof. This makes partial provider states
fail validation instead of silently deleting unrelated local data. Join remains
commutative, associative, and idempotent. Property tests exercise those laws
directly and also reduce 2-20 randomly generated offline replicas using
reordered, partitioned, and duplicated joins.

Reusing a dot for different data or different register addresses is an
invariant violation and fails closed. Every global vector counter must also be
witnessed by a retained candidate dot or same-register candidate context.
Hydration rejects dangling observations so a malformed or partial state cannot
use an unsubstantiated vector to discard local candidates during join. It also
rejects a context that references any currently retained candidate dot: exact
contexts contain dominated history only, so retained references would represent
invalid causal dominance or a cycle. The permanent dot-origin index proves that
each candidate and context dot belongs to the register claiming it, so copying
an omitted register's dot into unrelated context cannot satisfy validation.
Origin indexes join by dot and reject conflicting register identities.

## Materialization and conflicts

Concurrent candidates remain in the CRDT state. A deterministic materialized
snapshot is selected for legacy readers and immediate application:

1. a value sorts after a tombstone;
2. then HLC wall time and logical counter;
3. then device ID using locale-independent UTF-16 code-unit order;
4. then device counter.

Candidate ordering in canonical serialization uses the dot, not the selected
winner order. Dot and HLC objects are rebuilt with fixed property order so
provider JSON key ordering cannot change identity or serialized bytes.
Conflicts are emitted in collection, entity, field-path, and dot order.
Resolving a conflict creates a new write whose causal context covers all
observed candidates, so the resolution remains stable when stale replicas
return.

Internal field and position conflicts are emitted only while their parent
entity or string entry is materialized. An accepted parent deletion retains
the underlying causal metadata for future explicit recreation but suppresses
non-actionable child conflicts from the current conflict list. A concurrent
delete/update whose selected presence remains visible still exposes both the
presence conflict and all active internal conflicts.

## Complexity

State validation and canonical serialization are linear in registers,
candidates, and retained context dots. Join additionally compares the bounded
set of concurrent candidates within each register. Sorting is bounded by keys
within each map. Batch mutation clones the replica once, avoiding a full-state
copy per imported entity. `npm run bench:sync-crdt` reports non-gating
measurements for 1,000, 5,000, and 10,000 entities so accidental quadratic
behavior is visible during review.

## Follow-up boundaries

The encrypted v2 envelope, legacy baselines, migration preview, protection
snapshots, key rotation, and fail-closed protocol rules are described in
[`convergent-sync-protocol-v2.md`](./convergent-sync-protocol-v2.md). The final
change will integrate provider read-merge-write-verify loops, multi-window
locking, conflict resolution state, and localized settings UI.
