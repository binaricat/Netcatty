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

## State model

Each device owns a monotonically increasing counter. A write allocates a unique
dot `(deviceId, counter)` and records the version vector observed immediately
before that dot. A Hybrid Logical Clock (HLC) supplies a user-facing ordering
hint without defining causality.

The replica contains:

- one global dotted version vector and HLC;
- an MV-register for entity presence;
- an MV-register for collection position;
- an MV-register for every top-level entity field;
- an MV-register for every settings leaf path (arrays are atomic leaves);
- observed-remove string entries with their own presence and position
  registers.

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
silently hide the edit.

## Join

For each register, the join keeps:

1. candidates present on both sides;
2. left-only candidates not covered by the right causal context;
3. right-only candidates not covered by the left causal context.

Candidates causally dominated by another surviving candidate are removed. The
replica vector is the pointwise maximum. This makes join commutative,
associative, and idempotent. Property tests exercise those laws directly and
also reduce 2-20 randomly generated offline replicas using reordered,
partitioned, and duplicated joins.

Reusing a dot for different data or different register addresses is an
invariant violation and fails closed.

## Materialization and conflicts

Concurrent candidates remain in the CRDT state. A deterministic materialized
snapshot is selected for legacy readers and immediate application:

1. a value sorts after a tombstone;
2. then HLC wall time and logical counter;
3. then device ID;
4. then device counter.

Candidate ordering in canonical serialization uses the dot, not the selected
winner order. Dot and HLC objects are rebuilt with fixed property order so
provider JSON key ordering cannot change identity or serialized bytes.
Conflicts are emitted in collection, entity, field-path, and dot order.
Resolving a conflict creates a new write whose causal context covers all
observed candidates, so the resolution remains stable when stale replicas
return.

## Complexity

State validation, canonical serialization, and join are linear in the number
of registers plus candidates, with sorting bounded by keys within each map.
Batch mutation clones the replica once, avoiding a full-state copy per imported
entity. `npm run bench:sync-crdt` reports non-gating measurements for 1,000,
5,000, and 10,000 entities so accidental quadratic behavior is visible during
review.

## Follow-up boundaries

The next change will define the encrypted v2 envelope, legacy baselines,
migration preview, protection snapshots, key rotation, and fail-closed protocol
rules. The final change will integrate provider read-merge-write-verify loops,
multi-window locking, conflict resolution state, and localized settings UI.
