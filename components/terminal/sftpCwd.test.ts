import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalCwdTracker,
  invalidateTerminalCwdAfterCommand,
  probeBackendSessionCwdAfterCommand,
  resolvePreferredTerminalCwd,
} from "./sftpCwd";

test("resolvePreferredTerminalCwd prefers fresh backend pwd when requested", async () => {
  let backendCalls = 0;

  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/srv/app/current",
    sessionId: "session-1",
    preferFreshBackend: true,
    getSessionPwd: async (_sessionId, options) => {
      backendCalls += 1;
      assert.deepEqual(options, {
        allowHomeFallback: false,
        allowLoginShellFallback: true,
      });
      return { success: true, cwd: "/lost+found" };
    },
  });

  assert.equal(cwd, "/lost+found");
  assert.equal(backendCalls, 1);
});

test("resolvePreferredTerminalCwd returns the renderer cwd without probing the backend", async () => {
  let backendCalls = 0;

  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/srv/app/current",
    sessionId: "session-1",
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/root" };
    },
  });

  assert.equal(cwd, "/srv/app/current");
  assert.equal(backendCalls, 0);
});

test("resolvePreferredTerminalCwd falls back to renderer cwd when fresh backend pwd fails", async () => {
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/srv/app/current",
    sessionId: "session-1",
    preferFreshBackend: true,
    getSessionPwd: async (_sessionId, options) => {
      assert.deepEqual(options, {
        allowHomeFallback: false,
        allowLoginShellFallback: true,
      });
      return { success: false, error: "Could not determine cwd" };
    },
  });

  assert.equal(cwd, "/srv/app/current");
});

test("resolvePreferredTerminalCwd can require a backend-confirmed cwd", async () => {
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/srv/stale",
    sessionId: "session-1",
    preferFreshBackend: true,
    allowRendererFallback: false,
    getSessionPwd: async () => ({ success: false, error: "temporary failure" }),
  });

  assert.equal(cwd, null);
});

test("active-shell cwd resolution disables backend directory fallbacks", async () => {
  let receivedOptions: unknown;
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/home/alice",
    rendererCwdSource: "backend",
    sessionId: "session-1",
    preferFreshBackend: true,
    requireActiveShellCwd: true,
    getSessionPwd: async (_sessionId, options) => {
      receivedOptions = options;
      return { success: true, cwd: "/root/releases" };
    },
  });

  assert.deepEqual(receivedOptions, {
    allowHomeFallback: false,
    allowLoginShellFallback: false,
  });
  assert.equal(cwd, "/root/releases");
});

test("active-shell cwd resolution never overwrites trusted OSC 7 with the login shell cwd", async () => {
  let backendCalls = 0;
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/root/releases",
    rendererCwdSource: "osc7",
    sessionId: "session-1",
    preferFreshBackend: true,
    requireActiveShellCwd: true,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/home/alice" };
    },
  });

  assert.equal(cwd, "/root/releases");
  assert.equal(backendCalls, 0);
});

test("active-shell cwd resolution fails closed when only an untrusted cached cwd remains", async () => {
  let receivedOptions: unknown;
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/home/alice",
    rendererCwdSource: "backend",
    sessionId: "session-1",
    preferFreshBackend: true,
    requireActiveShellCwd: true,
    getSessionPwd: async (_sessionId, options) => {
      receivedOptions = options;
      return { success: false, error: "Could not determine cwd" };
    },
  });

  assert.deepEqual(receivedOptions, {
    allowHomeFallback: false,
    allowLoginShellFallback: false,
  });
  assert.equal(cwd, null);
});

test("resolvePreferredTerminalCwd falls back to backend pwd when no renderer cwd is known", async () => {
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: undefined,
    sessionId: "session-1",
    getSessionPwd: async (sessionId) => {
      assert.equal(sessionId, "session-1");
      return { success: true, cwd: "/home/alice" };
    },
  });

  assert.equal(cwd, "/home/alice");
});

test("resolvePreferredTerminalCwd returns null when neither source has a cwd", async () => {
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "",
    sessionId: "session-1",
    getSessionPwd: async () => ({ success: false }),
  });

  assert.equal(cwd, null);
});

test("terminal cwd tracker clears stale renderer cwd before falling back to backend pwd", async () => {
  const tracker = createTerminalCwdTracker();

  tracker.setRendererCwd("/srv/old-session");
  tracker.clearRendererCwd();

  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: tracker.getRendererCwd(),
    sessionId: "session-1",
    getSessionPwd: async () => ({ success: true, cwd: "/home/fresh-session" }),
  });

  assert.equal(cwd, "/home/fresh-session");
});

test("terminal cwd tracker preserves whether the cwd came from OSC 7", () => {
  const tracker = createTerminalCwdTracker();

  tracker.setRendererCwd("/home/alice", "backend");
  assert.equal(tracker.getRendererCwdSource(), "backend");

  tracker.setRendererCwd("/root/releases", "osc7");
  assert.equal(tracker.getRendererCwd(), "/root/releases");
  assert.equal(tracker.getRendererCwdSource(), "osc7");

  tracker.clearRendererCwd();
  assert.equal(tracker.getRendererCwdSource(), undefined);
});

test("terminal cwd tracker invalidates an old OSC 7 cwd when a command is submitted", async () => {
  const tracker = createTerminalCwdTracker();

  tracker.setRendererCwd("/home/alice", "osc7");
  tracker.markRendererCwdStale();

  assert.equal(tracker.getRendererCwd(), "/home/alice");
  assert.equal(tracker.getRendererCwdSource(), "stale");

  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: tracker.getRendererCwd(),
    rendererCwdSource: tracker.getRendererCwdSource(),
    sessionId: "session-1",
    preferFreshBackend: true,
    requireActiveShellCwd: true,
    getSessionPwd: async () => ({ success: false, error: "Could not determine cwd" }),
  });

  assert.equal(cwd, null);
});

test("command submission clears snapshot cwd and the cwd shared with SFTP follow", () => {
  const tracker = createTerminalCwdTracker();
  const changes: Array<[string, string | null]> = [];
  let snapshotCwd = "/home/alice";
  tracker.setRendererCwd("/home/alice", "osc7");

  invalidateTerminalCwdAfterCommand(
    tracker,
    "session-1",
    () => { snapshotCwd = ""; },
    (sessionId, cwd) => changes.push([sessionId, cwd]),
  );

  assert.equal(snapshotCwd, "");
  assert.equal(tracker.getRendererCwdSource(), "stale");
  assert.deepEqual(changes, [["session-1", null]]);
});

test("probeBackendSessionCwdAfterCommand skips when OSC 7 already reported after command", async () => {
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 2,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/tmp" };
    },
  });

  assert.equal(cwd, null);
  assert.equal(backendCalls, 0);
});

test("probeBackendSessionCwdAfterCommand probes backend when OSC 7 did not report", async () => {
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 3,
    getOsc7Signal: () => 3,
    getSessionPwd: async (sessionId, options) => {
      assert.equal(sessionId, "session-1");
      assert.deepEqual(options, {
        allowHomeFallback: false,
        allowLoginShellFallback: false,
      });
      return { success: true, cwd: "/var/log" };
    },
  });

  assert.equal(cwd, "/var/log");
});

test("probeBackendSessionCwdAfterCommand skips when OSC 7 confirms unchanged cwd after command", async () => {
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 2,
    getOsc7Signal: () => 3,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/home/user" };
    },
  });

  assert.equal(cwd, null);
  assert.equal(backendCalls, 0);
});

test("probeBackendSessionCwdAfterCommand still probes when cwd path is unchanged but OSC 7 did not fire", async () => {
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 5,
    getOsc7Signal: () => 5,
    getSessionPwd: async () => ({ success: true, cwd: "/srv/app" }),
  });

  assert.equal(cwd, "/srv/app");
});
