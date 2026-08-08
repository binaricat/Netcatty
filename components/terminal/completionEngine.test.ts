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
  remoteDelayMs: number;
} = {
  localEntries: [],
  remoteEntriesByPath: new Map(),
  remoteCalls: [],
  remoteDelayMs: 0,
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
        if (bridgeState.remoteDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, bridgeState.remoteDelayMs));
        }
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

const {
  getCompletions,
  getPathSuggestionsWithinBudget,
} = await import("./autocomplete/completionEngine.ts");
const {
  clearHistory,
  recordCommand,
  removeCommandHistoryEntry,
} = await import("./autocomplete/commandHistoryStore.ts");
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
  bridgeState.remoteDelayMs = 0;
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

test("removeCommandHistoryEntry removes only the matching host's autocomplete record", async () => {
  recordCommand("bad-command --flag", "host-1");
  recordCommand("bad-command --flag", "host-2");

  removeCommandHistoryEntry("bad-command --flag", "host-1");

  const completions = await getCompletions("bad-command", {
    hostId: "host-1",
    historyScope: "global",
    protocol: "local",
    cwd: "/repo",
  });
  assert.equal(
    completions.some((entry) => entry.source === "history" && entry.text === "bad-command --flag"),
    true,
  );

  const hostOnlyCompletions = await getCompletions("bad-command", {
    hostId: "host-1",
    historyScope: "host",
    protocol: "local",
    cwd: "/repo",
  });
  assert.equal(
    hostOnlyCompletions.some((entry) => entry.source === "history" && entry.text === "bad-command --flag"),
    false,
  );
});

test("removeCommandHistoryEntry trims command text like recordCommand", async () => {
  recordCommand("padded-cmd", "host-trim");
  assert.equal(removeCommandHistoryEntry("  padded-cmd  ", "host-trim"), true);

  const hostOnlyCompletions = await getCompletions("padded", {
    hostId: "host-trim",
    historyScope: "host",
    protocol: "local",
    cwd: "/repo",
  });
  assert.equal(
    hostOnlyCompletions.some((entry) => entry.source === "history" && entry.text === "padded-cmd"),
    false,
  );
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

test("getCompletions does not reuse in-flight remote relative listings after cwd changes", async () => {
  bridgeState.remoteDelayMs = 150;
  bridgeState.remoteEntriesByPath.set(".", [{ name: "home-only.txt", type: "file" }]);

  const first = getCompletions("cat ", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-inflight-cwd",
    pathBudgetMs: Infinity,
  });

  // First listing must be in flight before the shell cwd listing changes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  bridgeState.remoteEntriesByPath.set(".", [{ name: "worktree.txt", type: "file" }]);

  const second = await getCompletions("cat wo", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-inflight-cwd",
    pathBudgetMs: Infinity,
  });
  await first;

  assert.equal(bridgeState.remoteCalls.length, 2);
  assert.equal(second[0]?.text, "cat worktree.txt");
  assert.equal(second.some((entry) => entry.text === "cat home-only.txt"), false);
});

test("getCompletions returns local history before a slow remote path listing finishes", async () => {
  recordCommand("cat worktree.txt", "host-1");
  bridgeState.remoteDelayMs = 250;
  bridgeState.remoteEntriesByPath.set(".", [{ name: "worktree.txt", type: "file" }]);

  const started = Date.now();
  const completions = await getCompletions("cat wo", {
    hostId: "host-1",
    os: "linux",
    protocol: "ssh",
    sessionId: "session-slow-path",
    cwd: "~",
    pathBudgetMs: 40,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 200, `expected local suggestions within budget, took ${elapsed}ms`);
  assert.ok(
    completions.some((entry) => entry.source === "history" && entry.text === "cat worktree.txt"),
  );
  assert.equal(completions.some((entry) => entry.source === "path"), false);
});

test("getCompletions surfaces late path suggestions for cache-bypassed relative SSH cwd", async () => {
  recordCommand("cat worktree.txt", "host-1");
  bridgeState.remoteDelayMs = 250;
  bridgeState.remoteEntriesByPath.set(".", [{ name: "worktree.txt", type: "file" }]);

  let latePathSuggestions: Awaited<ReturnType<typeof getCompletions>> | null = null;
  const latePathPromise = new Promise<void>((resolve) => {
    void getCompletions("cat wo", {
      hostId: "host-1",
      os: "linux",
      protocol: "ssh",
      sessionId: "session-late-path",
      cwd: "/stale-fallback",
      cwdSource: "fallback",
      pathBudgetMs: 40,
      onLatePathSuggestions: (suggestions) => {
        latePathSuggestions = suggestions;
        resolve();
      },
    }).then((completions) => {
      assert.equal(completions.some((entry) => entry.source === "path"), false);
      assert.ok(
        completions.some((entry) => entry.source === "history" && entry.text === "cat worktree.txt"),
      );
    });
  });

  await latePathPromise;
  assert.ok(latePathSuggestions);
  assert.equal(latePathSuggestions![0]?.source, "path");
  assert.equal(latePathSuggestions![0]?.text, "cat worktree.txt");
});

test("getPathSuggestionsWithinBudget ignores late rejections after the soft timeout", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const pathPromise = new Promise<{ name: string; type: "file" }[]>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late path failure")), 80);
    });
    const entries = await getPathSuggestionsWithinBudget(pathPromise, 20);
    assert.deepEqual(entries, []);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("getPathSuggestionsWithinBudget delivers late entries after the soft timeout", async () => {
  const pathPromise = new Promise<{ name: string; type: "file" }[]>((resolve) => {
    setTimeout(() => resolve([{ name: "late.txt", type: "file" }]), 80);
  });
  let lateEntries: { name: string; type: "file" }[] | null = null;
  const entries = await getPathSuggestionsWithinBudget(pathPromise, 20, (late) => {
    lateEntries = late as { name: string; type: "file" }[];
  });
  assert.deepEqual(entries, []);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(lateEntries, [{ name: "late.txt", type: "file" }]);
});

test("getCompletions includes other hosts' history when historyScope is global", async () => {
  recordCommand("systemctl restart nginx", "host-a");
  recordCommand("systemctl status nginx", "host-b");

  const hostScoped = await getCompletions("systemctl", {
    hostId: "host-a",
    historyScope: "host",
  });
  assert.ok(
    hostScoped.some((entry) => entry.source === "history" && entry.text === "systemctl restart nginx"),
  );
  assert.equal(
    hostScoped.some((entry) => entry.source === "history" && entry.text === "systemctl status nginx"),
    false,
  );

  const globalScoped = await getCompletions("systemctl", {
    hostId: "host-a",
    historyScope: "global",
  });
  assert.ok(
    globalScoped.some((entry) => entry.source === "history" && entry.text === "systemctl restart nginx"),
  );
  assert.ok(
    globalScoped.some((entry) => entry.source === "history" && entry.text === "systemctl status nginx"),
  );
});
