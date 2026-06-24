import test from "node:test";
import assert from "node:assert/strict";

import type { FigSpec } from "./autocomplete/figSpecLoader.ts";

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type MockDirEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
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
const storySpec: FigSpec = {
  name: "story",
  subcommands: [
    {
      name: "open",
      args: { template: "filepaths" },
    },
    {
      name: "pick",
      args: { name: "item", generators: {} },
    },
  ],
};
const bridgeState: {
  localEntries: MockDirEntry[];
  remoteEntriesByPath: Map<string, MockDirEntry[]>;
  remoteCalls: string[];
} = {
  localEntries: [],
  remoteEntriesByPath: new Map(),
  remoteCalls: [],
};

Object.defineProperty(globalThis, "window", {
  value: {
    netcatty: {
      listFigSpecs: async () => ["story"],
      loadFigSpec: async (commandName: string) => commandName === "story" ? storySpec : null,
      listAutocompleteLocalDir: async (
        _path: string,
        foldersOnly: boolean,
        filterPrefix?: string,
        limit?: number,
      ) => {
        const prefix = (filterPrefix ?? "").toLowerCase();
        const entries = bridgeState.localEntries
          .filter((entry) => !foldersOnly || entry.type === "directory")
          .filter((entry) => !prefix || entry.name.toLowerCase().startsWith(prefix))
          .slice(0, limit ?? bridgeState.localEntries.length);
        return { success: true, entries };
      },
      listAutocompleteRemoteDir: async (
        _sessionId: string,
        path: string,
        foldersOnly: boolean,
        filterPrefix?: string,
        limit?: number,
      ) => {
        bridgeState.remoteCalls.push(path);
        const prefix = (filterPrefix ?? "").toLowerCase();
        const remoteEntries = bridgeState.remoteEntriesByPath.get(path) ?? [];
        const entries = remoteEntries
          .filter((entry) => !foldersOnly || entry.type === "directory")
          .filter((entry) => !prefix || entry.name.toLowerCase().startsWith(prefix))
          .slice(0, limit ?? remoteEntries.length);
        return { success: true, entries };
      },
    },
  },
  configurable: true,
});

const { getCompletions } = await import("./autocomplete/completionEngine.ts");
const { clearHistory, recordCommand } = await import("./autocomplete/commandHistoryStore.ts");
const {
  normalizePathTokenForLookup,
  shouldPreferRemoteShellCwd,
} = await import("./autocomplete/remotePathCompleter.ts");

test.beforeEach(() => {
  localStorage.clear();
  clearHistory();
  bridgeState.localEntries = [{ name: "package.json", type: "file" }];
  bridgeState.remoteEntriesByPath = new Map();
  bridgeState.remoteCalls = [];
});

test("getCompletions prioritizes spec-driven path suggestions over history", async () => {
  recordCommand("story open package-lock.json", "host-1");

  const completions = await getCompletions("story open pa", {
    hostId: "host-1",
    protocol: "local",
    cwd: "/repo",
  });

  assert.ok(completions.length > 0);
  assert.equal(completions[0]?.source, "path");
  assert.equal(completions[0]?.text, "story open package.json");

  const historyIndex = completions.findIndex((entry) =>
    entry.source === "history" && entry.text === "story open package-lock.json"
  );
  assert.ok(historyIndex > 0);
});

test("getCompletions does not treat generator-only spec args as path contexts", async () => {
  recordCommand("story pick package-choice", "host-1");

  const completions = await getCompletions("story pick pa", {
    hostId: "host-1",
    protocol: "local",
    cwd: "/repo",
  });

  assert.ok(completions.length > 0);
  assert.equal(completions[0]?.source, "history");
  assert.equal(completions[0]?.text, "story pick package-choice");
  assert.equal(completions.some((entry) => entry.source === "path"), false);
});

test("getCompletions uses the remote shell cwd for relative path arguments instead of stale home", async () => {
  bridgeState.remoteEntriesByPath.set("~", [{ name: "home-only.txt", type: "file" }]);
  bridgeState.remoteEntriesByPath.set(".", [{ name: "worktree.txt", type: "file" }]);

  const completions = await getCompletions("cat wo", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-1",
    cwd: "~",
  });

  assert.deepEqual(bridgeState.remoteCalls, ["."]);
  assert.equal(completions[0]?.source, "path");
  assert.equal(completions[0]?.text, "cat worktree.txt");
  assert.equal(completions.some((entry) => entry.text.includes("~")), false);
});

test("getCompletions uses absolute prompt cwd for remote relative path arguments", async () => {
  bridgeState.remoteEntriesByPath.set(".", [{ name: "old-user-file.txt", type: "file" }]);
  bridgeState.remoteEntriesByPath.set("/etc", [{ name: "passwd", type: "file" }]);

  const completions = await getCompletions("cat pa", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-1",
    cwd: "/etc",
    cwdSource: "prompt",
  });

  assert.deepEqual(bridgeState.remoteCalls, ["/etc"]);
  assert.equal(completions[0]?.source, "path");
  assert.equal(completions[0]?.text, "cat passwd");
  assert.equal(completions.some((entry) => entry.text === "cat old-user-file.txt"), false);
});

test("remote subdirectory lookups keep absolute prompt cwd", () => {
  const preferRelativeCwd = shouldPreferRemoteShellCwd("ssh", "session-1", "linux", "/etc", "prompt");

  assert.equal(preferRelativeCwd, false);
  assert.equal(
    normalizePathTokenForLookup("pam.d/", "/etc", { preferRelativeCwd }),
    "/etc/pam.d/",
  );
});

test("getCompletions keeps remote shell cwd when absolute cwd is only a fallback", async () => {
  bridgeState.remoteEntriesByPath.set("/old", [{ name: "old-user-file.txt", type: "file" }]);
  bridgeState.remoteEntriesByPath.set(".", [{ name: "worktree.txt", type: "file" }]);

  const completions = await getCompletions("cat wo", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-1",
    cwd: "/old",
    cwdSource: "fallback",
  });

  assert.deepEqual(bridgeState.remoteCalls, ["."]);
  assert.equal(completions[0]?.source, "path");
  assert.equal(completions[0]?.text, "cat worktree.txt");
  assert.equal(completions.some((entry) => entry.text === "cat old-user-file.txt"), false);
});

test("getCompletions does not reuse cached remote relative listings after cwd changes", async () => {
  bridgeState.remoteEntriesByPath.set(".", [{ name: "home-only.txt", type: "file" }]);

  await getCompletions("cat ", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-1",
  });

  bridgeState.remoteEntriesByPath.set(".", [{ name: "worktree.txt", type: "file" }]);

  const completions = await getCompletions("cat wo", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-1",
  });

  assert.equal(bridgeState.remoteCalls.length, 2);
  assert.equal(completions[0]?.text, "cat worktree.txt");
});
