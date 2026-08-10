import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./useVaultState.ts", import.meta.url), "utf8");

test("deleteSelectedSnippets merges into persisted vault under the shared lock", () => {
  assert.match(source, /const deleteSelectedSnippets = useCallback\(async/);
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*withVaultImportLock\("vault"/,
  );
  assert.match(
    source,
    /deleteSelectedSnippetsFromVault\(\s*latestSnippets\s*,\s*latestHosts\s*,\s*selectedSnippetIds,?\s*\)/,
  );
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*commitPluginImporterTransaction\(localStorageAdapter, \[[\s\S]*STORAGE_KEY_HOSTS[\s\S]*STORAGE_KEY_SNIPPETS/,
  );
  // Persistence rejection must be caught: callers void the promise after the
  // confirm dialog closes, so an uncaught throw would leave no retry feedback.
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*try \{\s*commitPluginImporterTransaction[\s\S]*catch \{[\s\S]*notify\.error\([\s\S]*Snippets could not be deleted/,
  );
  // Must not rebuild hosts from a per-window in-memory snapshot (popup race).
  assert.doesNotMatch(
    source,
    /deleteSelectedSnippetsFromVault\(\s*snippetsRef\.current\s*,\s*hostsRef\.current/,
  );
  // Paired writes must not publish in-memory state if only one key lands.
  assert.doesNotMatch(
    source,
    /deleteSelectedSnippets[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_HOSTS, encryptedHosts\)[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS/,
  );
});

test("updateHosts prunes stale snippet bindings under the vault lock", () => {
  // Cross-window bulk-delete can land while a host writer is queued with a
  // pre-delete encrypted blob. Re-check the live snippet catalog under the lock
  // before persisting so login/connect bindings are not restored.
  assert.match(
    source,
    /commitEncryptedHostsUnderVaultLock[\s\S]*pruneHostsStaleSnippetBindings\(hostsToPersist, latestSnippets\)/,
  );
  assert.match(
    source,
    /const writePromise = encryptPromise\.then\(async \(enc\) => \{[\s\S]*return commitEncryptedHostsUnderVaultLock\(ver, cleaned, enc\)/,
  );
});

test("importData replaces snippets instead of additive-rebasing", () => {
  // Sync restore / backup import must match the selected snapshot. Additive
  // rebase would keep concurrent disk-only ids and report a successful restore
  // that still contains snippets absent from the imported payload.
  assert.match(
    source,
    /updateSnippets\(payload\.snippets,\s*\{\s*replace:\s*true\s*\}\)/,
  );
});

test("updateSnippets disk writes take the shared vault lock", () => {
  // Unlocked snippet saves can interleave with bulk-delete's journaled commit
  // and discard concurrent edits. Ordinary writers must queue on the same lock
  // and be visible to waitForPendingVaultWrites.
  assert.match(
    source,
    /const updateSnippets = useCallback\(\(\s*data: Snippet\[\],\s*options\?: \{ replace\?: boolean \},\s*\) => \{[\s\S]*withVaultImportLock\("vault", async \(\) => \{[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS, rebased\)/,
  );
  assert.match(
    source,
    /snippetsWritePendingRef\.current = writePromise/,
  );
  assert.match(
    source,
    /waitForPendingVaultWrites[\s\S]*snippetsWritePendingRef\.current/,
  );
  assert.doesNotMatch(
    source,
    /const updateSnippets = useCallback\(\([\s\S]*?\) => \{[\s\S]*setSnippets\(cleaned\);\s*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS, cleaned\);\s*\}, \[\]\);/,
  );
});

test("updateSnippets rebases onto the latest persisted snapshot under the lock", () => {
  // Web Locks serialize writers but do not merge snapshots. A popup bulk-delete
  // that lands while a main-window save is queued must not be resurrected.
  assert.match(
    source,
    /rebaseSnippetVaultWrite\(\{\s*base,\s*ours: cleaned,\s*theirs:/,
  );
  assert.match(
    source,
    /snippetsWriteOwnerRef\.current !== ver/,
  );
});

test("clearVaultData replaces snippets without additive rebase", () => {
  // Clear All Local Data must not preserve concurrent disk-only snippet adds
  // that rebaseSnippetVaultWrite would otherwise keep.
  assert.match(
    source,
    /updateSnippets\(\[\],\s*\{\s*replace:\s*true\s*\}\)/,
  );
  assert.match(
    source,
    /const replace =\s*options\?\.replace === true \|\| snippetsWriteReplaceRef\.current/,
  );
  assert.match(
    source,
    /replace\s*\?\s*cleaned\s*:\s*rebaseSnippetVaultWrite/,
  );
  assert.match(
    source,
    /if \(replace\) \{\s*\/\/ Restore\/import\/clear[\s\S]*snippetsWriteBaseRef\.current = null/,
  );
});

test("updateSnippets preserves replace mode across superseded local saves", () => {
  // A clear/restore queued behind the vault lock must not lose replacement
  // intent when a later create/edit becomes the write owner — otherwise that
  // save additively rebases against the stale disk catalog and resurrects
  // every pre-replacement snippet.
  assert.match(
    source,
    /const snippetsWriteReplaceRef = useRef\(false\)/,
  );
  assert.match(
    source,
    /if \(options\?\.replace === true\) \{\s*snippetsWriteReplaceRef\.current = true;\s*\}/,
  );
  assert.match(
    source,
    /snippetsWriteBaseRef\.current = null;\s*snippetsWriteReplaceRef\.current = false;/,
  );
});

test("updateSnippets keeps the persisted rebase ancestor across superseded saves", () => {
  // Two queued local saves must not let the second treat the first save's
  // optimistic in-memory array as base — that array never hit disk, so an add
  // would look like a concurrent delete and be dropped.
  assert.match(
    source,
    /const snippetsWriteBaseRef = useRef<Snippet\[\] \| null>\(null\)/,
  );
  assert.match(
    source,
    /const base = snippetsWriteBaseRef\.current \?\? snippetsRef\.current/,
  );
  assert.match(
    source,
    /if \(snippetsWriteBaseRef\.current === null\) \{\s*snippetsWriteBaseRef\.current = base;\s*\}/,
  );
  assert.match(
    source,
    /const persisted = localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS, rebased\)/,
  );
  // Quota failure must keep the ancestor; clearing it would drop a local add on
  // the next save after space is freed.
  assert.match(
    source,
    /if \(!persisted\) \{[\s\S]*return "failed" as const;[\s\S]*\}\s*\/\/ Disk caught up[\s\S]*snippetsWriteBaseRef\.current = null/,
  );
  assert.match(
    source,
    /if \(!persisted\) \{[\s\S]*Snippets could not be saved/,
  );
});

test("snippet storage events keep queued local edits and their rebase ancestor", () => {
  // A cross-window write must not clear snippetsWriteBaseRef / replace optimistic
  // state while a local owner is still queued — the next edit would supersede
  // that owner from a remote-only snapshot and drop the first local mutation.
  assert.match(
    source,
    /if \(key === STORAGE_KEY_SNIPPETS\) \{[\s\S]*const pendingBase = snippetsWriteBaseRef\.current;\s*if \(pendingBase !== null\) \{[\s\S]*rebaseSnippetVaultWrite\(\{\s*base: pendingBase,\s*ours: snippetsRef\.current,\s*theirs: next,\s*\}\)/,
  );
  assert.doesNotMatch(
    source,
    /if \(key === STORAGE_KEY_SNIPPETS\) \{[\s\S]*snippetsWriteBaseRef\.current = null;\s*snippetsRef\.current = next/,
  );
});

test("snippet storage events retain outstanding replace snapshots", () => {
  // clear/restore sets replace with base null. Adopting a remote old catalog
  // before the lock is acquired would pollute memory; a later local edit would
  // still replace disk with that polluted snapshot.
  assert.match(
    source,
    /if \(key === STORAGE_KEY_SNIPPETS\) \{[\s\S]*if \(snippetsWriteReplaceRef\.current\) \{[\s\S]*return;\s*\}[\s\S]*snippetsRef\.current = next/,
  );
});

test("snippet storage events reject payloads older than current disk", () => {
  // After a queued replace commits, snippetsWriteReplaceRef is false again. A
  // delayed peer StorageEvent still carries the pre-replacement newValue; if
  // adopted, the next edit would persist that resurrected catalog.
  assert.match(
    source,
    /if \(key === STORAGE_KEY_SNIPPETS\) \{[\s\S]*event\.newValue !== localStorageAdapter\.readString\(STORAGE_KEY_SNIPPETS\)[\s\S]*return;/,
  );
});

test("startup host re-encryption uses the locked prune writer", () => {
  // A second renderer migrating saved hosts must not write the pre-delete
  // encryption blob unlocked after bulk-delete cleared login/connect bindings.
  assert.match(
    source,
    /migrateHostsFromLegacyLineTimestamps[\s\S]*commitEncryptedHostsUnderVaultLock\(ver, sanitized, enc\)/,
  );
  assert.match(
    source,
    /migrateHostsFromLegacyLineTimestamps[\s\S]*hostsWritePendingRef\.current = writePromise/,
  );
  assert.doesNotMatch(
    source,
    /migrateHostsFromLegacyLineTimestamps[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_HOSTS, enc\)/,
  );
});

test("startup snippet order backfill uses the locked vault writer", () => {
  // An initializing renderer must not rewrite a pre-delete snippet snapshot
  // unlocked after peer bulk-delete cleared host bindings — that resurrects
  // every selected snippet while binding cleanup remains committed.
  assert.match(
    source,
    /needsOrderPersist[\s\S]*withVaultImportLock\("vault", async \(\) => \{[\s\S]*readStoredArray<Snippet>\([\s\S]*STORAGE_KEY_SNIPPETS[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS, latest\)/,
  );
  assert.match(
    source,
    /needsOrderPersist[\s\S]*snippetsWritePendingRef\.current = writePromise/,
  );
  assert.doesNotMatch(
    source,
    /const orderedSnippets = normalizeVaultOrder\(savedSnippets\);\s*setSnippets\(orderedSnippets\);\s*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS, orderedSnippets\);/,
  );
});
