import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalCwdTracker,
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
      assert.deepEqual(options, { allowHomeFallback: false });
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
      assert.deepEqual(options, { allowHomeFallback: false });
      return { success: false, error: "Could not determine cwd" };
    },
  });

  assert.equal(cwd, "/srv/app/current");
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
    getSessionPwd: async (sessionId) => {
      assert.equal(sessionId, "session-1");
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
