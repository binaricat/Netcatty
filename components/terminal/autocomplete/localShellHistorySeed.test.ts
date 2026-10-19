import assert from "node:assert/strict";
import test from "node:test";

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function installLocalStorage(): LocalStorageMock {
  const store = new Map<string, string>();
  const localStorage: LocalStorageMock = {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  return localStorage;
}

const localStorage = installLocalStorage();

const files = new Map<string, string>();
let bridgeEnabled = true;
const bridge = {
  getHomeDir: async () => (bridgeEnabled ? "/Users/demo" : Promise.reject(new Error("no bridge"))),
  readLocalFile: async (path: string, options?: { maxBytes?: number }) => {
    if (!bridgeEnabled) throw new Error("no bridge");
    const text = files.get(path);
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    let bytes = new TextEncoder().encode(text);
    if (options?.maxBytes && bytes.byteLength > options.maxBytes) {
      bytes = bytes.subarray(bytes.byteLength - options.maxBytes);
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
};

Object.defineProperty(globalThis, "window", {
  value: { electron: bridge, netcatty: bridge },
  configurable: true,
});

const { clearHistory, queryHistory } = await import("../../../application/state/commandHistoryStore.ts");
const { seedLocalShellHistoryFromHistfiles } = await import("./localShellHistorySeed.ts");
const { getCompletions } = await import("./completionEngine.ts");

test.beforeEach(() => {
  localStorage.clear();
  clearHistory();
  files.clear();
  bridgeEnabled = true;
  (window as Window & { netcatty?: unknown }).netcatty = bridge;
});

test("seedLocalShellHistoryFromHistfiles imports zsh history for autocomplete prefix match", async () => {
  const hostId = "local-terminal";
  files.set(
    "/Users/demo/.zsh_history",
    ": 1700000000:0;sudo xattr -rd com.apple.quarantine /Applications/ClashX\\ Meta.app\n",
  );

  const seeded = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.ok(seeded > 0);

  const matches = queryHistory("sudo xattr", { hostId, limit: 5 });
  assert.equal(matches.length, 1);
  assert.match(matches[0].command, /ClashX/);

  const completions = await getCompletions("sudo xattr", {
    hostId,
    os: "macos",
    protocol: "local",
  });
  assert.ok(
    completions.some((c) => c.source === "history" && c.text.includes("ClashX")),
    `expected history completion, got ${JSON.stringify(completions.map((c) => ({ s: c.source, t: c.text })))}`,
  );
});

test("seedLocalShellHistoryFromHistfiles is idempotent for the same host after a successful import", async () => {
  const hostId = "local-terminal";
  files.set("/Users/demo/.zsh_history", ": 1700000000:0;pwd\n: 1700000001:0;ls\n");

  const first = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  const second = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.equal(first, 2);
  assert.equal(second, 0);
});

test("seedLocalShellHistoryFromHistfiles retries when histfiles were empty", async () => {
  const hostId = "local-terminal";

  const first = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.equal(first, 0);

  files.set("/Users/demo/.zsh_history", ": 1700000000:0;echo later\n");
  const second = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.equal(second, 1);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 1);
});

test("seedLocalShellHistoryFromHistfiles no-ops without a bridge and stays retryable", async () => {
  const hostId = "local-terminal";
  (window as Window & { netcatty?: unknown }).netcatty = undefined;

  const first = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.equal(first, 0);

  (window as Window & { netcatty?: unknown }).netcatty = bridge;
  files.set("/Users/demo/.zsh_history", ": 1700000000:0;pwd\n");
  const second = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.equal(second, 1);
});

test("seedLocalShellHistoryFromHistfiles dedupes concurrent calls for the same host", async () => {
  const hostId = "local-terminal";
  files.set("/Users/demo/.zsh_history", ": 1700000000:0;pwd\n");

  // Start the first seed without awaiting so the second call overlaps in-flight.
  const firstPromise = seedLocalShellHistoryFromHistfiles(hostId, "macos");
  const secondPromise = seedLocalShellHistoryFromHistfiles(hostId, "macos");
  const [a, b] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(queryHistory("pw", { hostId, limit: 5 }).length, 1);
});

test("seedLocalShellHistoryFromHistfiles drops a partial first line from a full-budget histfile tail", async () => {
  const hostId = "local-terminal";
  // Simulate a main-process maxBytes tail: exactly 512KiB ending mid-command,
  // then a complete command on the next line.
  const maxBytes = 512 * 1024;
  const complete = ": 1700000001:0;echo complete\n";
  const partialPrefix = "PARTIAL_TRUNCATED_COMMAND_WITHOUT_NEWLINE";
  const overhead = Buffer.byteLength(`${partialPrefix}\n\n${complete}`, "utf8");
  const filler = "x".repeat(maxBytes - overhead);
  const tail = `${partialPrefix}\n${filler}\n${complete}`;
  assert.equal(Buffer.byteLength(tail, "utf8"), maxBytes);

  files.set("/Users/demo/.zsh_history", tail);
  const seeded = await seedLocalShellHistoryFromHistfiles(hostId, "macos");
  assert.ok(seeded >= 1);
  assert.equal(queryHistory("echo", { hostId, limit: 5 })[0]?.command, "echo complete");
  assert.equal(queryHistory("PARTIAL", { hostId, limit: 5 }).length, 0);
});

test("seedLocalShellHistoryFromHistfiles joins Windows home paths for fish history", async () => {
  const hostId = "local-terminal";
  const previousHome = bridge.getHomeDir;
  bridge.getHomeDir = async () => "C:\\Users\\demo";
  try {
    files.set(
      "C:\\Users\\demo\\.config\\fish\\fish_history",
      "- cmd: echo fish\n  when: 1700000000\n",
    );

    const seeded = await seedLocalShellHistoryFromHistfiles(hostId, "windows");
    assert.equal(seeded, 1);
    assert.equal(queryHistory("echo", { hostId, limit: 5 })[0]?.command, "echo fish");
  } finally {
    bridge.getHomeDir = previousHome;
  }
});
