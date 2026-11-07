import test from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry } from "./commandHistoryStore";

import {
  STORAGE_KEY_COMMAND_HISTORY,
  STORAGE_KEY_COMMAND_HISTORY_CLEARED,
} from "../../infrastructure/config/storageKeys";

type StorageEventLike = { key: string | null; newValue: string | null; oldValue: string | null };
type StorageListener = (event: StorageEventLike) => void;

type DeferredRead = { resolve: (value: string) => void };

const COMMAND_HISTORY_STORAGE_KEY = STORAGE_KEY_COMMAND_HISTORY;

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
    configurable: true,
  });
  return store;
}

/**
 * The store registers its cross-window `storage` listener at module load, so
 * the DOM globals must exist before the dynamic imports below.
 */
function installWindow(): (key: string, newValue: string | null, oldValue?: string | null) => void {
  const listeners = new Set<StorageListener>();
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: (type: string, listener: StorageListener) => {
        if (type === "storage") listeners.add(listener);
      },
      removeEventListener: (type: string, listener: StorageListener) => {
        if (type === "storage") listeners.delete(listener);
      },
      netcatty: undefined as unknown,
    },
    configurable: true,
  });
  return (key: string, newValue: string | null, oldValue: string | null = null) => {
    for (const listener of listeners) listener({ key, newValue, oldValue });
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const storage = installLocalStorage();
const dispatchStorageEvent = installWindow();

const {
  clearHistory,
  flushCommandHistoryStore,
  getCommandHistoryClearGeneration,
  hasCommandHistoryBeenCleared,
  markCommandHistoryCleared,
  fuzzyQueryHistory,
  queryHistory,
  queryRecentHistoryByCommand,
  recordCommand,
  subscribeCommandHistoryCleared,
} = await import("./commandHistoryStore.ts");
const { seedLocalShellHistoryFromHistfiles } = await import(
  "../../components/terminal/autocomplete/localShellHistorySeed.ts"
);

function readPersistedCommands(): string[] {
  const raw = storage.get(COMMAND_HISTORY_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { entries: Array<{ command: string }> };
  return parsed.entries.map((entry) => entry.command);
}

function readPersistedGeneration(): number {
  const raw = storage.get(COMMAND_HISTORY_STORAGE_KEY);
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { clearGeneration?: number };
  return typeof parsed.clearGeneration === "number" ? parsed.clearGeneration : 0;
}

test("a fresh popup keeps compose recall on an ordinary peer write after an earlier clear", async () => {
  const baseline = JSON.stringify({ entries: [], version: 1, clearGeneration: 3 });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, baseline);
  const composeBar = await import("./composeBarHistoryStore.ts");
  composeBar.recordComposeBarHistory("fresh-popup", "echo popup-current-command");

  // No autocomplete query has loaded this renderer's command-history store.
  const recorded = JSON.stringify({
    entries: [{ command: "peer-command", hostId: "host-2", os: "linux", frequency: 1, createdAt: 1, lastUsedAt: 1 }],
    version: 1, clearGeneration: 3,
  });
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, recorded, baseline);
  assert.deepEqual(composeBar.getComposeBarHistory("fresh-popup"), ["echo popup-current-command"]);

  const cleared = JSON.stringify({ entries: [], version: 1, clearGeneration: 4 });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared, recorded);
  assert.deepEqual(composeBar.getComposeBarHistory("fresh-popup"), []);
});

test("a stale pending write cannot overwrite a peer clear before its storage event arrives", () => {
  clearHistory();
  recordCommand("old-command", "host-1");
  flushCommandHistoryStore();
  recordCommand("pending-before-clear", "host-1");

  // localStorage is already updated in the peer, but this renderer has not yet
  // processed its queued storage event when the pending save runs.
  const generation = readPersistedGeneration() + 1;
  storage.set(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify({
    entries: [], version: 1, clearGeneration: generation,
  }));
  flushCommandHistoryStore();
  assert.deepEqual(readPersistedCommands(), []);
  assert.equal(readPersistedGeneration(), generation);
  assert.deepEqual(queryHistory("old", { hostId: "host-1" }), []);

  recordCommand("new-after-clear", "host-1");
  flushCommandHistoryStore();
  assert.deepEqual(readPersistedCommands(), ["new-after-clear"]);
});

test("an ordinary peer write does not cancel a locally pending command", async () => {
  clearHistory();
  recordCommand("local-pending-command", "host-1");
  const before = storage.get(COMMAND_HISTORY_STORAGE_KEY)!;
  const ordinary = JSON.stringify({
    entries: [{ command: "peer-command", hostId: "host-2", os: "linux", frequency: 1, createdAt: 1, lastUsedAt: 1 }],
    version: 1, clearGeneration: getCommandHistoryClearGeneration(),
  });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, ordinary);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, ordinary, before);

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(readPersistedCommands().includes("local-pending-command"));
});

test("an external clear invalidates the cached history and cannot be resurrected", () => {
  storage.clear();
  clearHistory();

  recordCommand("stale-command --flag", "host-1");
  flushCommandHistoryStore();
  assert.ok(queryHistory("stale", { hostId: "host-1" }).length > 0);

  // Simulate another renderer (main window or a detached terminal popup)
  // clearing the shared localStorage entry.
  const cleared = JSON.stringify({ entries: [], version: 1, clearGeneration: 1 });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared);

  // The stale module-local cache must be dropped immediately.
  assert.equal(queryHistory("stale", { hostId: "host-1" }).length, 0);

  // A later recordCommand must persist only the new command, never the stale
  // snapshot it still held in memory.
  recordCommand("fresh-command", "host-1");
  flushCommandHistoryStore();
  assert.deepEqual(readPersistedCommands(), ["fresh-command"]);
});

test("clearHistory persists synchronously and cancels a pending debounced write", async () => {
  storage.clear();
  clearHistory();

  recordCommand("pending-command", "host-1");
  // No flush: the debounced write is still scheduled.
  clearHistory();
  assert.deepEqual(readPersistedCommands(), []);

  // Wait past the debounce window to prove the cancelled write cannot restore
  // the entries.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(readPersistedCommands(), []);
});

test("a local clear bumps the generation and notifies subscribers", () => {
  storage.clear();
  clearHistory();

  const before = getCommandHistoryClearGeneration();
  let notified = 0;
  const unsubscribe = subscribeCommandHistoryCleared(() => {
    notified += 1;
  });

  recordCommand("notify-local", "host-1");
  clearHistory();

  assert.equal(getCommandHistoryClearGeneration(), before + 1);
  assert.equal(readPersistedGeneration(), before + 1);
  assert.equal(notified, 1);

  unsubscribe();
  clearHistory();
  assert.equal(notified, 1);
});

test("an external clear notifies subscribers, while an external record does not", () => {
  storage.clear();
  clearHistory();

  const baseline = getCommandHistoryClearGeneration();
  let notified = 0;
  const unsubscribe = subscribeCommandHistoryCleared(() => {
    notified += 1;
  });

  // A normal record from another renderer keeps the generation: no clear event.
  const recorded = JSON.stringify({ entries: [], version: 1, clearGeneration: baseline });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, recorded);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, recorded);
  assert.equal(notified, 0);

  // A clear from another renderer bumps the generation: subscribers fire.
  const cleared = JSON.stringify({ entries: [], version: 1, clearGeneration: baseline + 1 });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared);
  assert.equal(notified, 1);
  assert.equal(getCommandHistoryClearGeneration(), baseline + 1);

  unsubscribe();
});

test("a histfile import that started before a clear is discarded", async () => {
  storage.clear();
  clearHistory();

  const hostId = `local-seed-clear-${Date.now()}`;
  const deferredReads: DeferredRead[] = [];
  (window as unknown as { netcatty?: unknown }).netcatty = {
    getHomeDir: async () => "/home/demo",
    readLocalFile: () =>
      new Promise<string>((resolve) => {
        deferredReads.push({ resolve });
      }),
  };

  const seedPromise = seedLocalShellHistoryFromHistfiles(hostId, "macos");
  // Let the seeder resolve getHomeDir and reach the histfile reads.
  await waitFor(() => deferredReads.length === 4);

  // The user clears history while the bridge reads are still pending.
  clearHistory();

  for (const deferred of deferredReads) {
    deferred.resolve(": 1700000000:0;echo seeded\n");
  }

  assert.equal(await seedPromise, 0);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 0);

  // The host is marked seeded so a later open cannot re-import the deleted
  // commands.
  assert.equal(await seedLocalShellHistoryFromHistfiles(hostId, "macos"), 0);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 0);
});

test("markCommandHistoryCleared persists a tombstone for histfile seeding", () => {
  storage.clear();
  assert.equal(hasCommandHistoryBeenCleared(), false);

  markCommandHistoryCleared();

  assert.equal(hasCommandHistoryBeenCleared(), true);
  assert.equal(storage.get(STORAGE_KEY_COMMAND_HISTORY_CLEARED), "true");
});

test("a first-time histfile import is skipped once history has been cleared", async () => {
  storage.clear();
  clearHistory();
  markCommandHistoryCleared();

  const hostId = `local-seed-tombstone-${Date.now()}`;
  (window as unknown as { netcatty?: unknown }).netcatty = {
    getHomeDir: async () => "/home/demo",
    readLocalFile: async () => ": 1700000000:0;echo resurrected\n",
  };

  assert.equal(await seedLocalShellHistoryFromHistfiles(hostId, "macos"), 0);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 0);
});

test("an external clear also drops in-memory compose-bar recall", async () => {
  const composeBar = await import("./composeBarHistoryStore.ts");
  storage.clear();
  clearHistory();
  composeBar.pruneComposeBarHistory([]);
  composeBar.recordComposeBarHistory("session-1", "echo compose");
  assert.deepEqual(composeBar.getComposeBarHistory("session-1"), ["echo compose"]);

  let notified = 0;
  const unsubscribe = composeBar.subscribeComposeBarHistoryCleared(() => {
    notified += 1;
  });

  // Simulate another renderer clearing command history. The compose-bar store
  // follows the same clear event, so a detached popup drops its recall too.
  const cleared = JSON.stringify({
    entries: [],
    version: 1,
    clearGeneration: getCommandHistoryClearGeneration() + 1,
  });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared);

  assert.deepEqual(composeBar.getComposeBarHistory("session-1"), []);
  assert.equal(notified, 1);

  unsubscribe();
});

test("saving after a command and peer writes read the clear generation without parsing the history", async (t) => {
  clearHistory();
  recordCommand("echo fast-path", "host-fast", "linux");
  assert.equal(flushCommandHistoryStore(), true);
  const raw = storage.get(COMMAND_HISTORY_STORAGE_KEY)!;
  assert.match(raw, /^\{"clearGeneration":\d+,/, "generation is serialized first");

  const parse = t.mock.method(JSON, "parse");
  recordCommand("echo fast-path-2", "host-fast", "linux");
  assert.equal(flushCommandHistoryStore(), true);
  // A peer window's save only needs the generation as well.
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, storage.get(COMMAND_HISTORY_STORAGE_KEY)!, raw);
  assert.equal(parse.mock.callCount(), 0);
  parse.mock.restore();
  assert.ok(queryHistory("echo fast", { hostId: "host-fast" }).some((entry) => entry.command === "echo fast-path-2"));
});

const QUERY_NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function historyEntry(command: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    command, hostId: "host-1", os: "linux", frequency: 1,
    createdAt: QUERY_NOW, lastUsedAt: QUERY_NOW, ...overrides,
  };
}

function installHistoryEntries(entries: HistoryEntry[]): void {
  clearHistory();
  const raw = JSON.stringify({
    clearGeneration: getCommandHistoryClearGeneration(), version: 1, entries,
  });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, raw);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, raw);
}

test("prefix history preserves relevance, stable ties, host isolation and best duplicate", (t) => {
  t.mock.method(Date, "now", () => QUERY_NOW);
  const entries = [
    historyEntry("vi", { frequency: 100 }),
    historyEntry("vim duplicate"),
    historyEntry("vim frequent", { frequency: 8, lastUsedAt: QUERY_NOW - DAY_MS }),
    historyEntry("Vim case"),
    historyEntry("vim tied"),
    historyEntry("vim duplicate", { hostId: "host-2", frequency: 5 }),
    historyEntry("unrelated", { frequency: 100 }),
  ];
  installHistoryEntries(entries);

  assert.deepEqual(queryHistory("vi", { limit: 4 }), [entries[5], entries[2], entries[3], entries[4]]);
  assert.deepEqual(queryHistory("vi", { hostId: "host-1", limit: 3 }), [entries[2], entries[1], entries[3]]);
  assert.deepEqual(queryHistory("VI", { limit: 1 }), [entries[0]]);
  assert.deepEqual(queryHistory("missing"), []);
  assert.deepEqual(queryHistory("vi", { limit: 0 }), []);
});

test("top-k history replaces and evicts duplicates without losing distinct results", (t) => {
  t.mock.method(Date, "now", () => QUERY_NOW);
  const entries = [
    historyEntry("vim a", { frequency: 2 }),
    historyEntry("vim b", { frequency: 3 }),
    historyEntry("vim c", { frequency: 4 }),
    historyEntry("vim b", { hostId: "host-2", frequency: 5 }),
    historyEntry("vim a", { hostId: "host-2", frequency: 6 }),
    historyEntry("vim a", { hostId: "host-3", frequency: 1 }),
  ];
  installHistoryEntries(entries);
  assert.deepEqual(queryHistory("vi", { limit: 2 }), [entries[4], entries[3]]);
  assert.deepEqual(fuzzyQueryHistory("vi", { limit: 2 }), [entries[4], entries[3]]);
});

test("fuzzy history preserves subsequence quality, recency, exclusions and stable ties", (t) => {
  t.mock.method(Date, "now", () => QUERY_NOW);
  const entries = [
    historyEntry("vi", { frequency: 100 }),
    historyEntry("vi alpha"),
    historyEntry("vi beta"),
    historyEntry("very indirect", { frequency: 2 }),
    historyEntry("vi stale", { lastUsedAt: QUERY_NOW - DAY_MS }),
    historyEntry("vi alpha", { hostId: "host-2", frequency: 3 }),
    historyEntry("iv does not match"),
  ];
  installHistoryEntries(entries);
  assert.deepEqual(fuzzyQueryHistory("vi", { limit: 4 }), [entries[5], entries[3], entries[2], entries[4]]);
  assert.deepEqual(fuzzyQueryHistory("vi", { hostId: "host-1", limit: 4 }), [entries[3], entries[1], entries[2], entries[4]]);
  assert.deepEqual(fuzzyQueryHistory(""), []);
  assert.deepEqual(fuzzyQueryHistory("vi", { limit: -1 }), []);
});

test("recent history preserves timestamps, command boundaries and quoted argument prefixes", () => {
  const entries = [
    historyEntry("cd /work/older", { lastUsedAt: QUERY_NOW - DAY_MS }),
    historyEntry("cd '/work/new folder'"),
    historyEntry("CD /work/tied"),
    historyEntry("cd /work/older", { hostId: "host-2", lastUsedAt: QUERY_NOW + 1 }),
    historyEntry("cd /other", { lastUsedAt: QUERY_NOW + 2 }),
    historyEntry("cdb /work/wrong", { lastUsedAt: QUERY_NOW + 3 }),
    historyEntry("cd /work/excluded", { lastUsedAt: QUERY_NOW + 4 }),
  ];
  installHistoryEntries(entries);
  const options = { commandName: " CD ", argumentPrefix: "'/work/", excludeCommand: "cd /work/excluded", limit: 3 };
  assert.deepEqual(queryRecentHistoryByCommand(options), [entries[3], entries[1], entries[2]]);
  assert.deepEqual(queryRecentHistoryByCommand({ ...options, hostId: "host-1" }), [entries[1], entries[2], entries[0]]);
  assert.deepEqual(queryRecentHistoryByCommand({ commandName: "" }), []);
  assert.deepEqual(queryRecentHistoryByCommand({ commandName: "cd", limit: 0 }), []);
});

test("fuzzy scoring preserves consecutive and word-boundary bonuses across long gaps", (t) => {
  t.mock.method(Date, "now", () => QUERY_NOW);
  const entries = [
    historyEntry("av-x"),
    historyEntry("avx"),
    historyEntry(`v${"a".repeat(1900)}x`),
    historyEntry("v-x"),
    historyEntry("v/x"),
    historyEntry("v_x"),
    historyEntry("v x"),
    historyEntry("vx adjacent"),
    historyEntry("v missing second character"),
    historyEntry("xv wrong order"),
  ];
  installHistoryEntries(entries);
  assert.deepEqual(fuzzyQueryHistory("vx"), [
    entries[7], entries[3], entries[4], entries[5], entries[6], entries[2], entries[1], entries[0],
  ]);
  assert.deepEqual(fuzzyQueryHistory("vv"), []);
});

for (const size of [4_000, 40_000]) {
  test(`history queries keep five best results with linear scoring for ${size} entries`, (t) => {
    t.mock.method(Date, "now", () => QUERY_NOW);
    const entries = Array.from({ length: size }, (_, i) => historyEntry(`vi file-${i}`, {
      // Unsorted scores/timestamps, with the best match at the end of the store.
      frequency: i === size - 1 ? size + 1 : (i * 7919) % size + 1,
      lastUsedAt: QUERY_NOW + (i === size - 1 ? size + 1 : (i * 7919) % size),
    }));
    installHistoryEntries(entries);
    queryHistory("missing"); // Warm the cache before measuring query operations.

    const expected = entries.slice().sort((a, b) => b.frequency - a.frequency).slice(0, 5);
    const pow = t.mock.method(Math, "pow");
    const lower = t.mock.method(String.prototype, "toLowerCase");
    // node:test cannot mock methods directly on arrays (including Array.prototype).
    const originalSort = Array.prototype.sort;
    const sortedSizes: number[] = [];
    Array.prototype.sort = function<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      sortedSizes.push(this.length);
      return originalSort.call(this, compare);
    };
    t.after(() => { Array.prototype.sort = originalSort; });
    const queries = [
      () => queryHistory("vi", { limit: 5 }),
      () => fuzzyQueryHistory("vi", { limit: 5 }),
      () => queryRecentHistoryByCommand({ commandName: "vi", argumentPrefix: "file-", limit: 5 }),
    ];

    for (const query of queries) {
      const beforePow = pow.mock.callCount();
      const beforeLower = lower.mock.callCount();
      const result = query();
      assert.deepEqual(result, expected);
      assert.equal(new Set(result.map((entry) => entry.command)).size, 5);
      assert.ok(pow.mock.callCount() - beforePow <= size, "score each entry at most once");
      assert.ok(lower.mock.callCount() - beforeLower <= 2 * size + 2, "normalize in one linear pass");
    }
    assert.deepEqual(sortedSizes, [], "never sort all matches before limiting");
  });
}
