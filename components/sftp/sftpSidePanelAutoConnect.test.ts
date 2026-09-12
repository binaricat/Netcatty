import test from "node:test";
import assert from "node:assert/strict";
import type { SftpPane } from "../../application/state/sftp/types";
import {
  connectionKeyMatchesHost,
  findPendingSftpRebindTargetPane,
  findReusableSftpSidePanelTab,
  isPendingSameEndpointSshSession,
  isRemoteSftpTabHealthy,
  rememberSftpSidePanelSourceStatus,
  resolvePendingSftpUploadCancellation,
  resolveSftpSidePanelTrackedSourceStatusUpdate,
  shouldAcceptPendingSftpUpload,
  shouldBlockPendingSftpUploadForSourceRebind,
  shouldCancelPendingSftpUpload,
  shouldCancelSettledPendingSftpRebindWithoutTarget,
  shouldDeferPendingSftpUploadForOriginFocus,
  shouldDeferSftpSidePanelAutoConnectForSession,
  shouldRebindSftpSidePanelSourceSession,
  shouldResetSftpSidePanelSourceSession,
  shouldSkipSftpSidePanelAutoConnect,
  shouldStartPendingSftpUploadRebind,
  shouldWaitForPendingSftpRebind,
} from "./sftpSidePanelAutoConnect";

const remoteConnectedTab = (overrides: Partial<SftpPane> = {}): SftpPane => ({
  id: "tab-1",
  connection: {
    id: "conn-1",
    hostId: "host-1",
    hostLabel: "server",
    isLocal: false,
    status: "connected",
    currentPath: "/var/www",
  },
  files: [],
  loading: false,
  reconnecting: false,
  error: null,
  connectionLogs: [],
  selectedFiles: new Set(),
  filter: "",
  filenameEncoding: "auto",
  showHiddenFiles: false,
  transferMutationToken: 0,
  ...overrides,
});

test("isRemoteSftpTabHealthy rejects loading tabs", () => {
  const tab = remoteConnectedTab({ loading: true });
  assert.equal(isRemoteSftpTabHealthy(tab, true), false);
});

test("isRemoteSftpTabHealthy rejects tabs without a backend SFTP session", () => {
  const tab = remoteConnectedTab();
  assert.equal(isRemoteSftpTabHealthy(tab, false), false);
});

test("isRemoteSftpTabHealthy rejects connecting tabs", () => {
  const tab = remoteConnectedTab({
    connection: {
      ...remoteConnectedTab().connection!,
      status: "connecting",
    },
  });
  assert.equal(isRemoteSftpTabHealthy(tab, true), false);
});

test("shouldSkipSftpSidePanelAutoConnect returns false for stale connected keys", () => {
  const tab = remoteConnectedTab({ loading: true });
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-key", "host-key", tab, true, "host-key"),
    false,
  );
});

test("shouldSkipSftpSidePanelAutoConnect rejects a healthy tab mapped to another endpoint", () => {
  const tab = remoteConnectedTab();
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-a-key", "host-a-key", tab, true, "host-b-key"),
    false,
  );
});

test("shouldSkipSftpSidePanelAutoConnect rejects when the active tab has no endpoint map", () => {
  const tab = remoteConnectedTab();
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-a-key", "host-a-key", tab, true, null),
    false,
  );
});

test("isPendingSameEndpointSshSession only waits for actively connecting SSH sessions", () => {
  const host = {
    id: "host-1",
    hostname: "server.example",
    port: 22,
    username: "root",
  };
  const baseSession = {
    hostId: "host-1",
    hostname: "server.example",
    port: 22,
    username: "root",
    protocol: "ssh",
  };

  assert.equal(
    isPendingSameEndpointSshSession({ ...baseSession, status: "connecting" }, host),
    true,
  );
  assert.equal(
    isPendingSameEndpointSshSession({ ...baseSession, status: "disconnected" }, host),
    false,
  );
  assert.equal(
    isPendingSameEndpointSshSession({ ...baseSession, status: "connected" }, host),
    false,
  );
});

test("connectionKeyMatchesHost accepts host-id prefix keys", () => {
  assert.equal(connectionKeyMatchesHost("host-1:server:22:ssh::root", "host-1"), true);
  assert.equal(connectionKeyMatchesHost("host-2:server:22:ssh::root", "host-1"), false);
  assert.equal(connectionKeyMatchesHost(null, "host-1"), false);
});

test("shouldAcceptPendingSftpUpload waits until the pane endpoint matches the drop", () => {
  const connected = {
    hostId: "host-1",
    isLocal: false,
    status: "connected",
  };
  assert.equal(
    shouldAcceptPendingSftpUpload({
      ownerPanelOpen: true,
      pendingHostId: "host-1",
      pendingConnectionKey: "host-1:b.example:22:ssh::root",
      activeHostId: "host-1",
      connection: connected,
      paneConnectionKey: "host-1:a.example:22:ssh::root",
    }),
    false,
  );
  assert.equal(
    shouldAcceptPendingSftpUpload({
      ownerPanelOpen: true,
      pendingHostId: "host-1",
      pendingConnectionKey: "host-1:b.example:22:ssh::root",
      activeHostId: "host-1",
      connection: connected,
      paneConnectionKey: null,
    }),
    false,
  );
  assert.equal(
    shouldAcceptPendingSftpUpload({
      ownerPanelOpen: true,
      pendingHostId: "host-1",
      pendingConnectionKey: "host-1:b.example:22:ssh::root",
      activeHostId: "host-1",
      connection: connected,
      paneConnectionKey: "host-1:b.example:22:ssh::root",
    }),
    true,
  );
});

test("shouldAcceptPendingSftpUpload waits for the terminal session that requested the upload", () => {
  const endpointKey = "host-1:prod.internal:22:ssh::deploy:";
  const connection = {
    hostId: "host-1",
    isLocal: false,
    status: "connected",
    sourceSessionId: "session-through-jump-a",
  };

  assert.equal(
    shouldAcceptPendingSftpUpload({
      ownerPanelOpen: true,
      pendingHostId: "host-1",
      pendingConnectionKey: endpointKey,
      pendingSourceSessionId: "session-through-jump-b",
      activeHostId: "host-1",
      connection,
      paneConnectionKey: endpointKey,
    }),
    false,
  );

  assert.equal(
    shouldAcceptPendingSftpUpload({
      ownerPanelOpen: true,
      pendingHostId: "host-1",
      pendingConnectionKey: endpointKey,
      pendingSourceSessionId: "session-through-jump-a",
      activeHostId: "host-1",
      connection,
      paneConnectionKey: endpointKey,
    }),
    true,
  );
});

test("a closed owner panel never starts a pending terminal upload", () => {
  assert.equal(shouldAcceptPendingSftpUpload({
    ownerPanelOpen: false,
    pendingHostId: "host-1",
    pendingConnectionKey: "host-1:target.example:22:ssh::alice",
    pendingSourceSessionId: "session-a",
    activeHostId: "host-1",
    connection: {
      hostId: "host-1",
      isLocal: false,
      status: "connected",
      sourceSessionId: "session-a",
    },
    paneConnectionKey: "host-1:target.example:22:ssh::alice",
  }), false);
});

test("pending terminal upload is cancelled when its source terminal changes", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingSourceSessionId: "session-a",
    activeHostId: "host-1",
    activeSessionId: "session-b",
    connection: null,
  }), "source-changed");
});

test("pending drop does not cancel while waiting for its own origin focus", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingOriginSessionId: "session-b",
    pendingSourceSessionId: "session-b",
    originSessionStatus: "connected",
    activeHostId: "host-1",
    activeSessionId: "session-a",
    focusedSessionId: "session-a",
    panelVisible: true,
    waitingForOriginFocus: true,
    waitingForSourceSession: true,
    connection: null,
  }), null);
});

test("Mosh/ET drops wait for origin focus before binding an SSH route", () => {
  assert.equal(shouldDeferPendingSftpUploadForOriginFocus({
    originSessionId: "mosh-b",
    focusedSessionId: "ssh-a",
  }), true);
  assert.equal(shouldDeferPendingSftpUploadForOriginFocus({
    originSessionId: "mosh-b",
    focusedSessionId: "mosh-b",
  }), false);
  assert.equal(shouldDeferPendingSftpUploadForOriginFocus({
    originSessionId: undefined,
    focusedSessionId: "ssh-a",
  }), false);
});

test("pending drop still cancels after origin focus landed and the user leaves", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingOriginSessionId: "session-b",
    pendingSourceSessionId: "session-b",
    originSessionStatus: "connected",
    activeHostId: "host-1",
    activeSessionId: "session-a",
    focusedSessionId: "session-a",
    panelVisible: true,
    waitingForOriginFocus: false,
    waitingForSourceSession: false,
    connection: null,
  }), "source-changed");
});

test("visible panel cancels an SSH drop when focus moves to same-host mosh or ET", () => {
  const params = {
    pendingHostId: "host-1",
    pendingOriginSessionId: "ssh-session",
    pendingSourceSessionId: undefined,
    activeHostId: "host-1",
    activeSessionId: null,
    focusedSessionId: "mosh-session",
    connection: {
      hostId: "host-1",
      sourceSessionId: "ssh-session",
      status: "connected",
    },
  };

  assert.equal(resolvePendingSftpUploadCancellation({
    ...params,
    panelVisible: true,
  }), "source-changed");
  assert.equal(resolvePendingSftpUploadCancellation({
    ...params,
    panelVisible: false,
  }), null);
});

test("pending terminal upload tolerates a transient missing focused session", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingSourceSessionId: "session-a",
    activeHostId: "host-1",
    activeSessionId: null,
    connection: null,
  }), null);
});

test("pending Mosh/ET origin upload is cancelled when its origin session disconnects", () => {
  const params = {
    pendingHostId: "host-1",
    pendingOriginSessionId: "mosh-session",
    pendingSourceSessionId: undefined,
    activeHostId: "host-1",
    activeSessionId: null,
    focusedSessionId: "mosh-session",
    panelVisible: true,
    connection: {
      hostId: "host-1",
      status: "connected",
    },
  };

  assert.equal(resolvePendingSftpUploadCancellation({
    ...params,
    originSessionStatus: "disconnected",
  }), "source-changed");
  assert.equal(resolvePendingSftpUploadCancellation({
    ...params,
    originSessionStatus: null,
  }), "source-changed");
  // Still pending origin routes must not cancel.
  assert.equal(resolvePendingSftpUploadCancellation({
    ...params,
    originSessionStatus: "connected",
  }), null);
  assert.equal(resolvePendingSftpUploadCancellation({
    ...params,
    originSessionStatus: "connecting",
  }), null);
});

test("pending SSH origin upload keeps waiting through a same-tab reconnect", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingOriginSessionId: "ssh-session",
    pendingSourceSessionId: "ssh-session",
    activeHostId: "host-1",
    activeSessionId: "ssh-session",
    focusedSessionId: "ssh-session",
    panelVisible: true,
    originSessionStatus: "disconnected",
    connection: {
      hostId: "host-1",
      sourceSessionId: "ssh-session",
      status: "connected",
    },
  }), null);
});

test("pending terminal upload is cancelled after its matching connection fails", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingSourceSessionId: "session-a",
    activeHostId: "host-1",
    activeSessionId: "session-a",
    connection: {
      hostId: "host-1",
      sourceSessionId: "session-a",
      status: "error",
    },
  }), "connection-failed");
});

test("pending terminal upload survives an old connection while strict reconnect is starting", () => {
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingSourceSessionId: "session-a",
    activeHostId: "host-1",
    activeSessionId: "session-a",
    connection: {
      hostId: "host-1",
      sourceSessionId: "session-old",
      status: "connected",
    },
  }), null);
  assert.equal(resolvePendingSftpUploadCancellation({
    pendingHostId: "host-1",
    pendingSourceSessionId: "session-a",
    activeHostId: "host-1",
    activeSessionId: "session-a",
    connection: {
      hostId: "host-1",
      sourceSessionId: "session-a",
      status: "connecting",
    },
  }), null);
});

test("an old disconnected pane does not cancel a pending strict rebind", () => {
  assert.equal(shouldCancelPendingSftpUpload("connection-failed", true), false);
  assert.equal(shouldCancelPendingSftpUpload("connection-failed", false), true);
  assert.equal(shouldCancelPendingSftpUpload("source-changed", true), true);
});

test("pending terminal upload is blocked while the same terminal tab changes routes", () => {
  assert.equal(shouldBlockPendingSftpUploadForSourceRebind({
    pendingSourceSessionId: "session-a",
    previousSessionId: "session-a",
    activeSessionId: "session-a",
    previousStatus: "connecting",
    activeStatus: "connected",
  }), true);
  assert.equal(shouldBlockPendingSftpUploadForSourceRebind({
    pendingSourceSessionId: "session-a",
    previousSessionId: "session-a",
    activeSessionId: "session-a",
    previousStatus: "connected",
    activeStatus: "connected",
  }), false);
});

test("terminal drop waits until the exact forced rebind settles", () => {
  assert.equal(shouldWaitForPendingSftpRebind({
    pendingSourceSessionId: "session-a",
    requestId: "drop-1",
    startedRequestId: null,
    connectionId: "old-connection",
  }), true);
  assert.equal(shouldWaitForPendingSftpRebind({
    pendingSourceSessionId: "session-a",
    requestId: "drop-1",
    startedRequestId: "drop-1",
    barrierRequestId: "drop-1",
    previousConnectionId: "old-connection",
    connectionId: "old-connection",
  }), true);
  assert.equal(shouldWaitForPendingSftpRebind({
    pendingSourceSessionId: "session-a",
    requestId: "drop-1",
    startedRequestId: "drop-1",
    barrierRequestId: "drop-1",
    previousConnectionId: "old-connection",
    connectionId: "unrelated-connection",
  }), true);
  assert.equal(shouldWaitForPendingSftpRebind({
    pendingSourceSessionId: "session-a",
    requestId: "drop-1",
    startedRequestId: "drop-1",
    settledRequestId: "drop-1",
    barrierRequestId: "drop-1",
    targetTabId: "new-tab",
    targetConnectionId: "new-connection",
    tabId: "old-tab",
    connectionId: "unrelated-connection",
  }), true);
  assert.equal(shouldWaitForPendingSftpRebind({
    pendingSourceSessionId: "session-a",
    requestId: "drop-1",
    startedRequestId: "drop-1",
    settledRequestId: "drop-1",
    barrierRequestId: "drop-1",
    targetTabId: "new-tab",
    targetConnectionId: "new-connection",
    tabId: "new-tab",
    connectionId: "new-connection",
  }), false);
});

test("a repeated terminal drop stops waiting when its shared strict connect settles", () => {
  assert.equal(shouldWaitForPendingSftpRebind({
    pendingSourceSessionId: "session-a",
    requestId: "drop-2",
    startedRequestId: "drop-2",
    settledRequestId: "drop-2",
    barrierRequestId: "drop-2",
    previousConnectionId: "connecting-connection",
    targetTabId: "connecting-tab",
    targetConnectionId: "connecting-connection",
    tabId: "connecting-tab",
    connectionId: "connecting-connection",
  }), false);
});

test("a terminal drop is cancelled when its settled forced target was closed", () => {
  assert.equal(shouldCancelSettledPendingSftpRebindWithoutTarget({
    pendingRequiresRebind: true,
    requestId: "drop-1",
    startedRequestId: "drop-1",
    settledRequestId: "drop-1",
    barrierRequestId: "drop-1",
    targetTabId: "closed-tab",
    targetConnectionId: "closed-connection",
    targetExists: false,
  }), true);
  assert.equal(shouldCancelSettledPendingSftpRebindWithoutTarget({
    pendingRequiresRebind: true,
    requestId: "drop-1",
    startedRequestId: "drop-1",
    settledRequestId: null,
    barrierRequestId: "drop-1",
    targetTabId: "closed-tab",
    targetConnectionId: "closed-connection",
    targetExists: false,
  }), false);
  assert.equal(shouldCancelSettledPendingSftpRebindWithoutTarget({
    pendingRequiresRebind: true,
    requestId: "drop-1",
    startedRequestId: "drop-1",
    settledRequestId: "drop-1",
    barrierRequestId: "drop-1",
    targetTabId: "live-tab",
    targetConnectionId: "live-connection",
    targetExists: true,
  }), false);
});

test("a forced upload target remains valid after moving to the other SFTP pane", () => {
  const movedTarget = remoteConnectedTab({
    id: "moved-tab",
    connection: {
      ...remoteConnectedTab().connection!,
      id: "moved-connection",
    },
  });
  assert.equal(findPendingSftpRebindTargetPane(
    [],
    [movedTarget],
    "moved-tab",
    "moved-connection",
  ), movedTarget);
});

test("Mosh and ET drops force a fresh SFTP route even when an old tab is healthy", () => {
  assert.equal(shouldStartPendingSftpUploadRebind({
    pendingMatchesTarget: true,
    requestId: "mosh-drop",
    startedRequestId: null,
    originSessionId: "mosh-session",
    sourceSessionId: undefined,
  }), true);
  assert.equal(shouldStartPendingSftpUploadRebind({
    pendingMatchesTarget: true,
    requestId: "mosh-drop",
    startedRequestId: "mosh-drop",
    originSessionId: "mosh-session",
    sourceSessionId: undefined,
  }), false);
});

test("findReusableSftpSidePanelTab ignores tabs stuck in loading after SSH disconnect", () => {
  const tab = remoteConnectedTab({ loading: true });
  const map = new Map([[tab.id, "host-key"]]);
  assert.equal(
    findReusableSftpSidePanelTab([tab], "host-1", "host-key", map, () => true),
    null,
  );
});

test("findReusableSftpSidePanelTab returns healthy tabs", () => {
  const tab = remoteConnectedTab();
  const map = new Map([[tab.id, "host-key"]]);
  assert.equal(
    findReusableSftpSidePanelTab([tab], "host-1", "host-key", map, () => true),
    tab,
  );
});

test("shouldResetSftpSidePanelSourceSession detects terminal session changes", () => {
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-b"), true);
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-a"), false);
  assert.equal(shouldResetSftpSidePanelSourceSession(null, "sess-a"), false);
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", null), false);
});

test("shouldRebindSftpSidePanelSourceSession treats SSH start-over as a transport change", () => {
  // Same terminal tab id after Start over - transport was replaced even though
  // the session id did not change.
  assert.equal(
    shouldRebindSftpSidePanelSourceSession({
      previousSessionId: "sess-a",
      nextSessionId: "sess-a",
      previousStatus: "disconnected",
      nextStatus: "connected",
    }),
    true,
  );
  assert.equal(
    shouldRebindSftpSidePanelSourceSession({
      previousSessionId: "sess-a",
      nextSessionId: "sess-a",
      previousStatus: "connecting",
      nextStatus: "connected",
    }),
    true,
  );
  assert.equal(
    shouldRebindSftpSidePanelSourceSession({
      previousSessionId: "sess-a",
      nextSessionId: "sess-a",
      previousStatus: "connected",
      nextStatus: "connected",
    }),
    false,
  );
  assert.equal(
    shouldRebindSftpSidePanelSourceSession({
      previousSessionId: "sess-a",
      nextSessionId: "sess-b",
      previousStatus: "connected",
      nextStatus: "connected",
    }),
    true,
  );
  assert.equal(
    shouldRebindSftpSidePanelSourceSession({
      previousSessionId: "sess-a",
      nextSessionId: "sess-a",
      previousStatus: "disconnected",
      nextStatus: "connecting",
    }),
    false,
  );
});

test("shouldDeferSftpSidePanelAutoConnectForSession only waits during an active reconnect", () => {
  assert.equal(
    shouldDeferSftpSidePanelAutoConnectForSession({
      activeSessionId: "sess-a",
      sessionStatus: "disconnected",
    }),
    false,
  );
  assert.equal(
    shouldDeferSftpSidePanelAutoConnectForSession({
      activeSessionId: "sess-a",
      sessionStatus: "connecting",
    }),
    true,
  );
  assert.equal(
    shouldDeferSftpSidePanelAutoConnectForSession({
      activeSessionId: "sess-a",
      sessionStatus: "connected",
    }),
    false,
  );
  assert.equal(
    shouldDeferSftpSidePanelAutoConnectForSession({
      activeSessionId: null,
      sessionStatus: "connecting",
    }),
    false,
  );
});

test("resolveSftpSidePanelTrackedSourceStatusUpdate remembers background disconnects", () => {
  assert.deepEqual(
    resolveSftpSidePanelTrackedSourceStatusUpdate({
      trackedSessionId: "sess-a",
      sessionStatus: "disconnected",
    }),
    { sessionId: "sess-a", status: "disconnected" },
  );
  assert.deepEqual(
    resolveSftpSidePanelTrackedSourceStatusUpdate({
      trackedSessionId: "sess-a",
      sessionStatus: "connecting",
    }),
    { sessionId: "sess-a", status: "connecting" },
  );
  assert.equal(
    resolveSftpSidePanelTrackedSourceStatusUpdate({
      trackedSessionId: "sess-a",
      sessionStatus: "connected",
    }),
    null,
  );
  assert.equal(
    resolveSftpSidePanelTrackedSourceStatusUpdate({
      trackedSessionId: null,
      sessionStatus: "disconnected",
    }),
    null,
  );
});

test("rememberSftpSidePanelSourceStatus keeps the linked SSH status across non-SSH focus", () => {
  assert.equal(
    rememberSftpSidePanelSourceStatus({
      previousStatus: "connecting",
      activeSessionId: null,
      activeSessionStatus: null,
    }),
    "connecting",
  );
  assert.equal(
    rememberSftpSidePanelSourceStatus({
      previousStatus: "disconnected",
      activeSessionId: null,
      activeSessionStatus: null,
    }),
    "disconnected",
  );
  assert.equal(
    rememberSftpSidePanelSourceStatus({
      previousStatus: "disconnected",
      activeSessionId: "sess-a",
      activeSessionStatus: "connected",
    }),
    "connected",
  );
});

test("failed terminal reconnect keeps a healthy standalone SFTP tab", () => {
  const tab = remoteConnectedTab();
  const sessionChanged = shouldRebindSftpSidePanelSourceSession({
    previousSessionId: "sess-a",
    nextSessionId: "sess-a",
    previousStatus: "connecting",
    nextStatus: "disconnected",
  });
  assert.equal(sessionChanged, false);
  assert.equal(
    !sessionChanged && shouldSkipSftpSidePanelAutoConnect(
      "host-1:key",
      "host-1:key",
      tab,
      true,
      "host-1:key",
    ),
    true,
  );
  assert.equal(
    shouldRebindSftpSidePanelSourceSession({
      previousSessionId: "sess-a",
      nextSessionId: "sess-a",
      previousStatus: "connecting",
      nextStatus: "connected",
    }),
    true,
  );
});

test("session change still requires rebind even when the endpoint key matches", () => {
  const tab = remoteConnectedTab();
  // Callers must not skip auto-connect solely because the tab is healthy —
  // a new focused terminal may share host/port/user while proxy/jump differs.
  // Path stickiness is handled by remembered initialPath on reconnect.
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-b"), true);
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-key", "host-key", tab, true, "host-key"),
    true,
  );
  // Reuse lookup still finds the tab, but callers pass sessionChanged and skip
  // it so connect rebinds with the new sourceSessionId.
  assert.equal(
    findReusableSftpSidePanelTab(
      [tab],
      "host-1",
      "host-key",
      new Map([[tab.id, "host-key"]]),
      () => true,
    ),
    tab,
  );
});
