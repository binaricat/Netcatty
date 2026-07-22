import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mergeLatestFollowTerminalCwdHostSetting,
  resolveHostFollowTerminalCwd,
  resolveSftpFollowTerminalCwdTargetHost,
  runInitialFollowTerminalCwdSync,
  shouldApplyFollowTerminalCwdSyncResult,
  shouldClearBlockedFollowOnReach,
  shouldFollowTerminalCwdNavigate,
} from "./sftpFollowTerminalCwd";

const base = {
  followEnabled: true,
  isVisible: true,
  terminalCwd: "/home/user/project",
  currentPath: "/home/user",
  connectionId: "conn-1",
  hasActiveWork: false,
  isConnected: true,
};

const readComponentSource = (relativePath: string) => (
  readFileSync(new URL(relativePath, import.meta.url), "utf8")
);

test("shouldFollowTerminalCwdNavigate returns true when follow is on and paths differ", () => {
  assert.equal(shouldFollowTerminalCwdNavigate(base), true);
});

test("shouldFollowTerminalCwdNavigate returns false when paths already match", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({ ...base, currentPath: "/home/user/project" }),
    false,
  );
});

test("shouldFollowTerminalCwdNavigate returns false when follow is disabled", () => {
  assert.equal(shouldFollowTerminalCwdNavigate({ ...base, followEnabled: false }), false);
});

test("shouldFollowTerminalCwdNavigate returns false while interactive work is active", () => {
  assert.equal(shouldFollowTerminalCwdNavigate({ ...base, hasActiveWork: true }), false);
});

test("shouldFollowTerminalCwdNavigate returns false without a known terminal cwd", () => {
  assert.equal(shouldFollowTerminalCwdNavigate({ ...base, terminalCwd: null }), false);
});

test("shouldFollowTerminalCwdNavigate returns false when cwd is blocked after a failed follow", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      blockedFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    false,
  );
});

test("shouldFollowTerminalCwdNavigate ignores blocked cwd for a different connection", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      connectionId: "conn-2",
      blockedFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    true,
  );
});

test("shouldFollowTerminalCwdNavigate ignores blocked cwd when terminal cwd changed", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      terminalCwd: "/home/user/other",
      blockedFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    true,
  );
});

test("shouldFollowTerminalCwdNavigate does not recapture manual navigation after the cwd was handled", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      currentPath: "/srv/bookmark",
      handledFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    false,
  );
});

test("shouldFollowTerminalCwdNavigate resumes when the terminal cwd changes", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      terminalCwd: "/home/user/other",
      currentPath: "/srv/bookmark",
      handledFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    true,
  );
});

test("resolveHostFollowTerminalCwd inherits the global setting until the host overrides it", () => {
  assert.equal(resolveHostFollowTerminalCwd(undefined, true), true);
  assert.equal(resolveHostFollowTerminalCwd(undefined, false), false);
  assert.equal(resolveHostFollowTerminalCwd(true, false), true);
  assert.equal(resolveHostFollowTerminalCwd(false, true), false);
});

test("resolveSftpFollowTerminalCwdTargetHost prefers the visible SFTP host", () => {
  const terminalHost = { id: "terminal-host" };
  const visibleHost = { id: "visible-sftp-host" };

  assert.equal(
    resolveSftpFollowTerminalCwdTargetHost(visibleHost, terminalHost),
    visibleHost,
  );
  assert.equal(
    resolveSftpFollowTerminalCwdTargetHost(null, terminalHost),
    terminalHost,
  );
});

test("visible SFTP host override can enable follow when terminal host inherits global off", () => {
  const terminalHost = { id: "terminal-host", sftpFollowTerminalCwd: undefined };
  const visibleHost = { id: "visible-sftp-host", sftpFollowTerminalCwd: true };
  const followHost = resolveSftpFollowTerminalCwdTargetHost(visibleHost, terminalHost);

  assert.equal(resolveHostFollowTerminalCwd(followHost?.sftpFollowTerminalCwd, false), true);
});

test("mergeLatestFollowTerminalCwdHostSetting refreshes the follow flag without losing display overrides", () => {
  const connectedHost = {
    id: "host-1",
    hostname: "session.example.com",
    sftpFollowTerminalCwd: false,
  };
  const latestHost = {
    id: "host-1",
    hostname: "vault.example.com",
    sftpFollowTerminalCwd: true,
  };

  assert.deepEqual(
    mergeLatestFollowTerminalCwdHostSetting(connectedHost, latestHost),
    {
      id: "host-1",
      hostname: "session.example.com",
      sftpFollowTerminalCwd: true,
    },
  );
});

test("mergeLatestFollowTerminalCwdHostSetting keeps optimistic session override until vault updates", () => {
  const connectedHost = {
    id: "host-1",
    hostname: "session.example.com",
    sftpFollowTerminalCwd: false,
  };
  const latestHost = {
    id: "host-1",
    hostname: "vault.example.com",
  };

  assert.deepEqual(
    mergeLatestFollowTerminalCwdHostSetting(connectedHost, latestHost, false),
    {
      id: "host-1",
      hostname: "session.example.com",
      sftpFollowTerminalCwd: false,
    },
  );
});

test("mergeLatestFollowTerminalCwdHostSetting drops stale session override when vault clears the follow flag", () => {
  const connectedHost = {
    id: "host-1",
    hostname: "session.example.com",
    sftpFollowTerminalCwd: true,
  };
  const latestHost = {
    id: "host-1",
    hostname: "vault.example.com",
  };

  assert.deepEqual(
    mergeLatestFollowTerminalCwdHostSetting(connectedHost, latestHost),
    {
      id: "host-1",
      hostname: "session.example.com",
      sftpFollowTerminalCwd: undefined,
    },
  );
});

test("shouldClearBlockedFollowOnReach clears when the active connection reaches the blocked cwd", () => {
  assert.equal(
    shouldClearBlockedFollowOnReach(
      { connectionId: "conn-1", terminalCwd: "/home/user/project" },
      "conn-1",
      "/home/user/project",
      false,
    ),
    true,
  );
});

test("shouldClearBlockedFollowOnReach keeps block while navigation is still loading", () => {
  assert.equal(
    shouldClearBlockedFollowOnReach(
      { connectionId: "conn-1", terminalCwd: "/home/user/project" },
      "conn-1",
      "/home/user/project",
      true,
    ),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult rejects stale follow results after cwd changes", () => {
  let generation = 0;
  const followA = generation;

  generation += 1;
  const followB = generation;

  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: followB,
      currentGeneration: generation,
      followEnabled: true,
      canFollow: true,
    }),
    true,
  );
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: followA,
      currentGeneration: generation,
      followEnabled: true,
      canFollow: true,
    }),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult rejects results after follow is unavailable", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: false,
      canFollow: true,
    }),
    false,
  );
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: false,
    }),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult rejects results for an old connection", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedConnectionId: "conn-1",
      liveConnectionId: "conn-2",
      paneConnectionId: "conn-2",
    }),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult rejects results for an old terminal cwd", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedConnectionId: "conn-1",
      liveConnectionId: "conn-1",
      paneConnectionId: "conn-1",
      expectedTerminalCwd: "/srv/old",
      liveTerminalCwd: "/srv/new",
    }),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult rejects missing live cwd when required", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedConnectionId: "conn-1",
      liveConnectionId: "conn-1",
      paneConnectionId: "conn-1",
      expectedTerminalCwd: "/srv/project",
      liveTerminalCwd: null,
      requireLiveTerminalCwd: true,
    }),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult allows missing live cwd when target was fetched fresh", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedConnectionId: "conn-1",
      liveConnectionId: "conn-1",
      paneConnectionId: "conn-1",
      expectedTerminalCwd: "/srv/project",
      liveTerminalCwd: null,
    }),
    true,
  );
});

test("SftpSidePanel follow effect is not keyed by SFTP path changes", () => {
  const source = readComponentSource("../SftpSidePanel.tsx");
  const followEffect = source.match(
    /useEffect\(\(\) => \{\n\s+if \(!effectiveFollowTerminalCwd[\s\S]*?void syncFollowToTerminalCwd\(\);\n\s+\}, \[\n(?<deps>[\s\S]*?)\n\s+\]\);/,
  );

  assert.ok(followEffect?.groups?.deps);
  assert.match(followEffect.groups.deps, /activeTerminalCwd/);
  assert.match(followEffect.groups.deps, /connectionId/);
  assert.doesNotMatch(followEffect.groups.deps, /currentPath|connectionPath/);
});

test("SftpSidePanel passes a stale-result guard into automatic follow navigation", () => {
  const source = readComponentSource("../SftpSidePanel.tsx");

  assert.match(
    source,
    /navigateTo\("left", terminalCwd, \{\n\s+shouldApply: shouldApplyCurrentFollowSync,\n\s+\}\)/,
  );
});

test("SftpSidePanel invalidates follow state whenever the follow toggle changes", () => {
  const source = readComponentSource("../SftpSidePanel.tsx");
  const toggleHandler = source.match(
    /const handleToggleFollowTerminalCwd = useCallback\(\(\) => \{[\s\S]*?\}, \[effectiveFollowTerminalCwd/,
  );

  assert.ok(toggleHandler);
  assert.match(toggleHandler[0], /invalidateInFlightFollowSync\(\);/);
  assert.doesNotMatch(toggleHandler[0], /if \(!nextEnabled\)/);
});

test("first-open sync navigates from stale home to a backend-confirmed cwd", async () => {
  let handled = null;
  let blocked = null;
  let navigatedTo = null;
  const connection = { id: "conn-1", currentPath: "/home/alice", status: "connected" };

  const completed = await runInitialFollowTerminalCwdSync({
    expectedConnectionId: "conn-1",
    staleTerminalCwd: "/home/alice",
    getFreshTerminalCwd: async () => "/srv/project",
    isEligible: () => true,
    getConnection: () => connection,
    navigate: async (cwd, shouldApply) => {
      assert.equal(shouldApply(), true);
      navigatedTo = cwd;
      connection.currentPath = cwd;
      return "reached";
    },
    setHandled: (value) => { handled = value; },
    setBlocked: (value) => { blocked = value; },
  });

  assert.equal(completed, true);
  assert.equal(navigatedTo, "/srv/project");
  assert.deepEqual(handled, { connectionId: "conn-1", terminalCwd: "/home/alice" });
  assert.equal(blocked, null);
});

test("first-open sync can retry a failed probe and cancels stale results", async () => {
  let attempts = 0;
  let eligible = true;
  let navigations = 0;
  const connection = { id: "conn-1", currentPath: "/home/alice", status: "connected" };
  const run = () => runInitialFollowTerminalCwdSync({
    expectedConnectionId: "conn-1",
    staleTerminalCwd: "/home/alice",
    getFreshTerminalCwd: async () => (++attempts === 1 ? null : "/srv/project"),
    isEligible: () => eligible,
    getConnection: () => connection,
    navigate: async () => { navigations += 1; return "reached"; },
    setHandled: () => {},
    setBlocked: () => {},
  });

  assert.equal(await run(), false);
  assert.equal(await run(), true);
  assert.equal(attempts, 2);
  assert.equal(navigations, 1);

  eligible = false;
  assert.equal(await run(), false);
  assert.equal(navigations, 1);
});

test("SftpSidePanel bounds first-open retries and disables cached fallback", () => {
  const source = readComponentSource("../SftpSidePanel.tsx");

  assert.match(
    source,
    /preferFreshBackend: true,\n\s+allowRendererFallback: false/,
  );
  assert.match(source, /initialFollowRetryRef\.current\.attempts >= 3/);
  assert.match(source, /setInitialFollowRetryNonce\(\(value\) => value \+ 1\)/);
});
