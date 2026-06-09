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

test("probeBackendSessionCwdAfterCommand skips when cwd revision already advanced", async () => {
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    cwdRevisionAtCommand: 1,
    getCwdRevision: () => 2,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/tmp" };
    },
  });

  assert.equal(cwd, null);
  assert.equal(backendCalls, 0);
});

test("probeBackendSessionCwdAfterCommand probes backend when revision is unchanged", async () => {
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    cwdRevisionAtCommand: 3,
    getCwdRevision: () => 3,
    getSessionPwd: async (sessionId) => {
      assert.equal(sessionId, "session-1");
      return { success: true, cwd: "/var/log" };
    },
  });

  assert.equal(cwd, "/var/log");
});
