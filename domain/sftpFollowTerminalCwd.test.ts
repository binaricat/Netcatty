import test from "node:test";
import assert from "node:assert/strict";
import {
  isFollowOriginStillCurrent,
  mergeLatestFollowTerminalCwdHostSetting,
  resolveHostFollowTerminalCwd,
  resolveSftpFollowTerminalCwdTargetHost,
  shouldApplyFollowTerminalCwdSyncResult,
  shouldClearBlockedFollowOnReach,
  shouldFollowTerminalCwdNavigate,
  shouldInvalidateFollowBookkeepingOnCwdChange,
  shouldLatchInitialFollowInterruption,
  shouldReleaseInitialFollowSyncAttempt,
  shouldResetInitialFollowTerminalCwdSync,
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

test("isFollowOriginStillCurrent treats a missing origin as bound to the live focused terminal", () => {
  assert.equal(isFollowOriginStillCurrent({
    expectedOriginId: null,
    liveOriginId: null,
  }), true);
  assert.equal(isFollowOriginStillCurrent({
    expectedOriginId: null,
    liveOriginId: "mosh-b",
  }), false);
  assert.equal(isFollowOriginStillCurrent({
    expectedOriginId: "mosh-a",
    liveOriginId: "mosh-b",
  }), false);
  assert.equal(isFollowOriginStillCurrent({
    expectedOriginId: "mosh-a",
    liveOriginId: "mosh-a",
  }), true);
});

test("shouldApplyFollowTerminalCwdSyncResult rejects a null origin after focus appears", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedSessionId: null,
      liveSessionId: null,
    }),
    true,
  );
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedSessionId: null,
      liveSessionId: "mosh-b",
    }),
    false,
  );
});

test("shouldApplyFollowTerminalCwdSyncResult rejects results after the focused session changes", () => {
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedSessionId: "session-a",
      liveSessionId: "session-b",
    }),
    false,
  );
  assert.equal(
    shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration: 2,
      currentGeneration: 2,
      followEnabled: true,
      canFollow: true,
      expectedSessionId: "session-a",
      liveSessionId: "session-a",
    }),
    true,
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

test("follow bookkeeping keeps handled state across hidden-panel null cwd transitions", () => {
  // Hidden panels receive activeTerminalCwd={null} and get the last live value
  // back on reshow: the visibility transitions may not drop handled follow
  // bookkeeping when the cwd did not actually change.
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: null,
      lastCwd: "/home/user/project",
      isVisible: false,
    }),
    false,
  );
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: "/home/user/project",
      lastCwd: "/home/user/project",
      isVisible: false,
    }),
    false,
  );
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: "/home/user/project",
      lastCwd: "/home/user/project",
      isVisible: true,
    }),
    false,
  );
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: null,
      lastCwd: null,
      isVisible: false,
    }),
    false,
  );
});

test("follow bookkeeping invalidates on a real terminal cwd change", () => {
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: "/home/user/other",
      lastCwd: "/home/user/project",
      isVisible: true,
    }),
    true,
  );
  // A cwd that changed while the panel was hidden still invalidates on reshow.
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: "/home/user/other",
      lastCwd: null,
      isVisible: true,
    }),
    true,
  );
  // A `null` while the surface is visible means the linked terminal session
  // changed (or closed) and its cwd cache is empty: in-flight follow results
  // of the previous session must be invalidated.
  assert.equal(
    shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: null,
      lastCwd: "/home/user/project",
      isVisible: true,
    }),
    true,
  );
});

test("first-open sync reset re-arms on a replaced connection", () => {
  assert.equal(
    shouldResetInitialFollowTerminalCwdSync({
      isVisible: true,
      ownerPanelOpen: true,
      connectionId: "conn-2",
      trackedConnectionId: "conn-1",
    }),
    true,
  );
});

test("first-open sync reset re-arms after a fresh open on the same connection", () => {
  assert.equal(
    shouldResetInitialFollowTerminalCwdSync({
      isVisible: false,
      ownerPanelOpen: false,
      connectionId: "conn-1",
      trackedConnectionId: "conn-1",
    }),
    true,
  );
});

test("first-open sync reset survives hiding the surface while the owner panel stays open", () => {
  // Terminal tab switches / side-panel tool switches keep the panel mounted
  // and open: the user's browsed directory and filename filter must survive.
  assert.equal(
    shouldResetInitialFollowTerminalCwdSync({
      isVisible: false,
      ownerPanelOpen: true,
      connectionId: "conn-1",
      trackedConnectionId: "conn-1",
    }),
    false,
  );
  assert.equal(
    shouldResetInitialFollowTerminalCwdSync({
      isVisible: true,
      ownerPanelOpen: true,
      connectionId: "conn-1",
      trackedConnectionId: "conn-1",
    }),
    false,
  );
});

test("first-open sync attempt is released while visible or after the owner panel closed", () => {
  assert.equal(shouldReleaseInitialFollowSyncAttempt({ isVisible: true, ownerPanelOpen: true }), true);
  assert.equal(shouldReleaseInitialFollowSyncAttempt({ isVisible: true, ownerPanelOpen: false }), true);
  assert.equal(shouldReleaseInitialFollowSyncAttempt({ isVisible: false, ownerPanelOpen: false }), true);
});

test("first-open sync attempt stays consumed while hidden with the owner panel open", () => {
  // Terminal tab switch while the fresh-CWD probe is still pending: the
  // interrupted attempt must not re-arm, or returning to the tab re-runs the
  // first-open sync and navigates away from the browsed directory.
  assert.equal(shouldReleaseInitialFollowSyncAttempt({ isVisible: false, ownerPanelOpen: true }), false);
});

test("first-open probe is latched as interrupted on a hide with the owner panel open", () => {
  // Terminal-tab switch while the fresh-CWD probe is pending: the probe must be
  // latched as interrupted so it cannot navigate once the tab is reshown.
  assert.equal(
    shouldLatchInitialFollowInterruption({ isVisible: false, ownerPanelOpen: true }),
    true,
  );
  assert.equal(
    shouldLatchInitialFollowInterruption({ isVisible: true, ownerPanelOpen: true }),
    false,
  );
  // A panel close is not an interruption latch: the reset guard re-arms there.
  assert.equal(
    shouldLatchInitialFollowInterruption({ isVisible: false, ownerPanelOpen: false }),
    false,
  );
});
