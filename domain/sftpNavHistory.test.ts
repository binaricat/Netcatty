import assert from "node:assert/strict";
import test from "node:test";

import {
  applySftpNavHistoryTransition,
  canGoBack,
  canGoForward,
  createNavHistory,
  DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES,
  getCurrentNavPath,
  goBack,
  goForward,
  peekBackPath,
  peekForwardPath,
  pushNavHistory,
  resetNavHistory,
  resolveSftpConnectNavHistory,
  resolveSftpEffectiveNavHistoryMode,
} from "./sftpNavHistory.ts";

test("createNavHistory initializes empty or with an initial path", () => {
  const empty = createNavHistory();
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.index, -1);
  assert.equal(empty.maxEntries, DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES);
  assert.equal(getCurrentNavPath(empty), null);
  assert.equal(canGoBack(empty), false);
  assert.equal(canGoForward(empty), false);
  assert.equal(peekBackPath(empty), null);
  assert.equal(peekForwardPath(empty), null);

  const seeded = createNavHistory("/home/alice");
  assert.deepEqual(seeded.entries, ["/home/alice"]);
  assert.equal(seeded.index, 0);
  assert.equal(getCurrentNavPath(seeded), "/home/alice");
  assert.equal(canGoBack(seeded), false);
  assert.equal(canGoForward(seeded), false);

  const fallbackMax = createNavHistory("/home", 0);
  assert.equal(fallbackMax.maxEntries, DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES);

  const customMax = createNavHistory("/home", 3.9);
  assert.equal(customMax.maxEntries, 3);
});

test("pushNavHistory appends distinct paths and ignores empty or duplicate current paths", () => {
  const h0 = createNavHistory("/a");
  const h1 = pushNavHistory(h0, "/b");
  const h2 = pushNavHistory(h1, "/c");

  // Immutability check
  assert.deepEqual(h0.entries, ["/a"]);
  assert.deepEqual(h2.entries, ["/a", "/b", "/c"]);
  assert.equal(h2.index, 2);

  // Duplicate current path is a no-op returning the same reference
  assert.equal(pushNavHistory(h2, "/c"), h2);
  // Empty path is a no-op
  assert.equal(pushNavHistory(h2, ""), h2);

  // Custom comparator dedups case-insensitive paths (e.g. Windows)
  const win = createNavHistory("C:\\Users");
  const sameWin = pushNavHistory(
    win,
    "c:\\users",
    (a, b) => a.toLowerCase() === b.toLowerCase(),
  );
  assert.equal(sameWin, win);
});

test("goBack and goForward traverse history without mutating or losing forward entries", () => {
  let history = createNavHistory("/a");
  history = pushNavHistory(history, "/b");
  history = pushNavHistory(history, "/c");

  assert.equal(canGoBack(history), true);
  assert.equal(canGoForward(history), false);
  assert.equal(peekBackPath(history), "/b");

  const back1 = goBack(history);
  assert.equal(back1.path, "/b");
  assert.equal(back1.history.index, 1);
  assert.deepEqual(back1.history.entries, ["/a", "/b", "/c"]);
  assert.equal(canGoBack(back1.history), true);
  assert.equal(canGoForward(back1.history), true);
  assert.equal(peekBackPath(back1.history), "/a");
  assert.equal(peekForwardPath(back1.history), "/c");

  // Pushing the current path while mid-history must NOT wipe forward entries
  assert.equal(pushNavHistory(back1.history, "/b"), back1.history);

  const back2 = goBack(back1.history);
  assert.equal(back2.path, "/a");
  assert.equal(back2.history.index, 0);
  assert.equal(canGoBack(back2.history), false);
  assert.equal(canGoForward(back2.history), true);

  // Going back past the start is a no-op
  const back3 = goBack(back2.history);
  assert.equal(back3.path, null);
  assert.equal(back3.history, back2.history);

  const fwd1 = goForward(back2.history);
  assert.equal(fwd1.path, "/b");
  assert.equal(fwd1.history.index, 1);

  const fwd2 = goForward(fwd1.history);
  assert.equal(fwd2.path, "/c");
  assert.equal(fwd2.history.index, 2);
  assert.equal(canGoForward(fwd2.history), false);

  // Going forward past the end is a no-op
  const fwd3 = goForward(fwd2.history);
  assert.equal(fwd3.path, null);
  assert.equal(fwd3.history, fwd2.history);
});

test("pushNavHistory truncates forward entries after stepping back", () => {
  let history = createNavHistory("/a");
  history = pushNavHistory(history, "/b");
  history = pushNavHistory(history, "/c");
  history = pushNavHistory(history, "/d");

  const stepped = goBack(goBack(history).history).history;
  assert.equal(getCurrentNavPath(stepped), "/b");
  assert.equal(canGoForward(stepped), true);

  const branched = pushNavHistory(stepped, "/x");
  assert.deepEqual(branched.entries, ["/a", "/b", "/x"]);
  assert.equal(branched.index, 2);
  assert.equal(canGoBack(branched), true);
  assert.equal(canGoForward(branched), false);
});

test("pushNavHistory enforces bounded maxEntries capacity", () => {
  let history = createNavHistory("/p0", 3);
  history = pushNavHistory(history, "/p1");
  history = pushNavHistory(history, "/p2");
  history = pushNavHistory(history, "/p3");
  history = pushNavHistory(history, "/p4");

  assert.deepEqual(history.entries, ["/p2", "/p3", "/p4"]);
  assert.equal(history.index, 2);

  // Default 50-entry bound
  let defaultBounded = createNavHistory("/dir-0");
  for (let i = 1; i <= 75; i += 1) {
    defaultBounded = pushNavHistory(defaultBounded, `/dir-${i}`);
  }
  assert.equal(defaultBounded.entries.length, DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES);
  assert.equal(defaultBounded.entries[0], "/dir-26");
  assert.equal(defaultBounded.entries[49], "/dir-75");
  assert.equal(defaultBounded.index, 49);
});

test("resetNavHistory clears previous history and starts fresh at the new path", () => {
  const reset = resetNavHistory("/var/www");
  assert.deepEqual(reset.entries, ["/var/www"]);
  assert.equal(reset.index, 0);
  assert.equal(canGoBack(reset), false);
  assert.equal(canGoForward(reset), false);

  const cleared = resetNavHistory(null);
  assert.deepEqual(cleared.entries, []);
  assert.equal(cleared.index, -1);
});

test("applySftpNavHistoryTransition handles push, back, forward, none, and fallback", () => {
  // Uninitialized pane history seeds from currentPath before pushing target
  const seededPush = applySftpNavHistoryTransition({
    history: undefined,
    currentPath: "/home",
    targetPath: "/var",
    mode: "push",
  });
  assert.deepEqual(seededPush.entries, ["/home", "/var"]);
  assert.equal(seededPush.index, 1);

  // Back moves pointer without wiping forward entries
  const steppedBack = applySftpNavHistoryTransition({
    history: seededPush,
    currentPath: "/var",
    targetPath: "/home",
    mode: "back",
  });
  assert.deepEqual(steppedBack.entries, ["/home", "/var"]);
  assert.equal(steppedBack.index, 0);

  // Refresh (mode: "none") leaves history and forward stack untouched
  const afterRefresh = applySftpNavHistoryTransition({
    history: steppedBack,
    currentPath: "/home",
    targetPath: "/home",
    mode: "none",
  });
  assert.equal(afterRefresh, steppedBack);

  // Forward restores pointer
  const steppedForward = applySftpNavHistoryTransition({
    history: afterRefresh,
    currentPath: "/home",
    targetPath: "/var",
    mode: "forward",
  });
  assert.deepEqual(steppedForward.entries, ["/home", "/var"]);
  assert.equal(steppedForward.index, 1);

  // If history drifted concurrently so back target no longer matches, fall back to push
  const drifted = applySftpNavHistoryTransition({
    history: steppedForward,
    currentPath: "/var",
    targetPath: "/unexpected",
    mode: "back",
  });
  assert.deepEqual(drifted.entries, ["/home", "/var", "/unexpected"]);
  assert.equal(drifted.index, 2);
});

test("resolveSftpConnectNavHistory resets on host switch and preserves on same-endpoint reconnect", () => {
  const existing = pushNavHistory(createNavHistory("/home/alice"), "/var/log");

  const switchedHost = resolveSftpConnectNavHistory({
    sameEndpointReconnect: false,
    previousHistory: existing,
    startPath: "/home/bob",
  });
  assert.deepEqual(switchedHost.entries, ["/home/bob"]);
  assert.equal(switchedHost.index, 0);
  assert.equal(canGoBack(switchedHost), false);

  const reconnectedSamePath = resolveSftpConnectNavHistory({
    sameEndpointReconnect: true,
    previousHistory: existing,
    startPath: "/var/log",
  });
  assert.equal(reconnectedSamePath, existing);

  const reconnectedFallbackPath = resolveSftpConnectNavHistory({
    sameEndpointReconnect: true,
    previousHistory: existing,
    startPath: "/home/alice",
  });
  assert.deepEqual(reconnectedFallbackPath.entries, ["/home/alice", "/var/log", "/home/alice"]);
  assert.equal(reconnectedFallbackPath.index, 2);
});

test("resolveSftpEffectiveNavHistoryMode inherits pending transitions on matching mid-flight refresh", () => {
  const pending = { connectionId: "conn-1", path: "/var/log", mode: "forward" as const };

  assert.equal(
    resolveSftpEffectiveNavHistoryMode({
      requestedMode: "none",
      pending,
      connectionId: "conn-1",
      targetPath: "/var/log",
    }),
    "forward",
  );

  // Different path or connection does not inherit
  assert.equal(
    resolveSftpEffectiveNavHistoryMode({
      requestedMode: "none",
      pending,
      connectionId: "conn-1",
      targetPath: "/var",
    }),
    "none",
  );
  assert.equal(
    resolveSftpEffectiveNavHistoryMode({
      requestedMode: "none",
      pending,
      connectionId: "conn-2",
      targetPath: "/var/log",
    }),
    "none",
  );

  // Explicit non-"none" mode always wins
  assert.equal(
    resolveSftpEffectiveNavHistoryMode({
      requestedMode: "back",
      pending,
      connectionId: "conn-1",
      targetPath: "/var/log",
    }),
    "back",
  );
});
