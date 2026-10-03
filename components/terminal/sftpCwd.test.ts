import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalCwdTracker,
  invalidateTerminalCwdAfterCommand,
  shouldPreserveTerminalCwdAcrossCommand,
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

test("probeBackendSessionCwdAfterCommand keeps retrying past an intermediate queued cwd until it stabilizes", async () => {
  // Queued submissions without OSC 7: the second `cd` still holds the original
  // baseline, so observing the intermediate `/one` must not be published right
  // away — only a read that repeats is treated as the settled result.
  let backendCalls = 0;
  const cwds = ["/one", "/two", "/two"];
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: cwds[backendCalls - 1] ?? "/two" };
    },
    baselineCwd: "/start",
    retryDelayMs: 1,
  });

  assert.equal(cwd, "/two");
  assert.equal(backendCalls, 3);
});

test("probeBackendSessionCwdAfterCommand publishes its last differing read when retries are exhausted mid-transition", async () => {
  let backendCalls = 0;
  const cwds = ["/one", "/two", "/three", "/three"];
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: cwds[backendCalls - 1] ?? "/three" };
    },
    baselineCwd: "/start",
    maxAttempts: 3,
    retryDelayMs: 1,
  });

  assert.equal(cwd, "/three");
  assert.equal(backendCalls, 3);
});

test("probeBackendSessionCwdAfterCommand publishes a differing read without a baseline", async () => {
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/tmp" };
    },
    retryDelayMs: 1,
  });

  assert.equal(cwd, "/tmp");
  assert.equal(backendCalls, 1);
});

test("probeBackendSessionCwdAfterCommand retries a stale pre-command read until the pwd changes", async () => {
  let backendCalls = 0;
  const cwds = ["/home/user", "/home/user", "/tmp"];
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: cwds[backendCalls - 1] ?? "/tmp" };
    },
    baselineCwd: "/home/user",
    retryDelayMs: 1,
  });

  assert.equal(cwd, "/tmp");
  assert.equal(backendCalls, 3);
});

test("probeBackendSessionCwdAfterCommand publishes nothing when every retry still reads the stale baseline", async () => {
  // A command such as `sleep 2 && cd /tmp` can outlast the retry window: all
  // reads still report the pre-command directory, which is unconfirmed, so
  // republishing it would leave SFTP follow one command behind (#3589) — the
  // probe must leave the cwd invalid instead.
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/home/user" };
    },
    baselineCwd: "/home/user",
    retryDelayMs: 1,
  });

  assert.equal(cwd, null);
  assert.equal(backendCalls, 3);
});

test("probeBackendSessionCwdAfterCommand still publishes the executed cwd on a later probe after a delayed cd lands", async () => {
  // After the delayed cwd finally lands, the next command's probe (or OSC 7)
  // resolves the follow cwd without being pinned to the old baseline.
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/tmp" };
    },
    baselineCwd: "/home/user",
    maxAttempts: 2,
    retryDelayMs: 1,
  });

  assert.equal(cwd, "/tmp");
  assert.equal(backendCalls, 2);
});

test("probeBackendSessionCwdAfterCommand stops retrying once cancelled", async () => {
  let backendCalls = 0;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => 1,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: true, cwd: "/home/user" };
    },
    baselineCwd: "/home/user",
    retryDelayMs: 1,
    isCancelled: () => true,
  });

  assert.equal(cwd, null);
  assert.equal(backendCalls, 1);
});

test("probeBackendSessionCwdAfterCommand stops retrying once OSC 7 reports after command", async () => {
  let backendCalls = 0;
  let osc7Signal = 1;
  const cwd = await probeBackendSessionCwdAfterCommand({
    sessionId: "session-1",
    osc7SignalAtCommand: 1,
    getOsc7Signal: () => osc7Signal,
    getSessionPwd: async () => {
      backendCalls += 1;
      osc7Signal += 1;
      return { success: true, cwd: "/home/user" };
    },
    baselineCwd: "/home/user",
    retryDelayMs: 1,
  });

  assert.equal(cwd, null);
  assert.equal(backendCalls, 1);
});

test("active-shell cwd resolution trusts an inferred cwd without extra exec", async () => {
  let backendCalls = 0;
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/data/docker",
    rendererCwdSource: "inferred",
    sessionId: "session-1",
    preferFreshBackend: true,
    allowRendererFallback: false,
    requireActiveShellCwd: true,
    getSessionPwd: async () => {
      backendCalls += 1;
      return { success: false, error: "extra exec channels" };
    },
  });

  assert.equal(cwd, "/data/docker");
  assert.equal(backendCalls, 0);
});

test("single-channel command submission keeps the cwd SFTP follow already has", () => {
  assert.equal(shouldPreserveTerminalCwdAcrossCommand(true), true);
  assert.equal(shouldPreserveTerminalCwdAcrossCommand(false), false);
});
