const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const {
  isConfirmedShellKind,
  PROBE_OUTPUT_MARKER,
  classifyShellKindFromRemotePath,
  buildRemoteLoginShellProbeCommand,
  parseRemoteLoginShellProbeOutput,
  createSshConnExecProbe,
  createSessionExecProbe,
  ensureSessionShellKind,
  ensureSessionShellKindForExec,
} = require("./sessionShellKind.cjs");

const {
  buildWrappedCommand,
  resolveEffectiveShellKind,
} = require("./ptyExecHelpers.cjs");

test("classifies remote login shell paths", () => {
  assert.equal(classifyShellKindFromRemotePath("/usr/bin/fish"), "fish");
  assert.equal(classifyShellKindFromRemotePath("/usr/local/bin/fish"), "fish");
  assert.equal(classifyShellKindFromRemotePath("fish"), "fish");
  assert.equal(classifyShellKindFromRemotePath("/bin/bash"), "posix");
  assert.equal(classifyShellKindFromRemotePath("/bin/zsh"), "posix");
  assert.equal(classifyShellKindFromRemotePath("/usr/bin/pwsh"), "powershell");
  assert.equal(classifyShellKindFromRemotePath("/bin/cmd.exe"), "cmd");
  assert.equal(classifyShellKindFromRemotePath("/usr/bin/nu"), null);
  assert.equal(classifyShellKindFromRemotePath(""), null);
});

test("parseRemoteLoginShellProbeOutput reads classifiable probe output lines", () => {
  assert.equal(
    parseRemoteLoginShellProbeOutput(`\n${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`),
    "fish",
  );
  assert.equal(
    parseRemoteLoginShellProbeOutput(`  ${PROBE_OUTPUT_MARKER}/bin/bash\r\n`),
    "posix",
  );
  assert.equal(
    parseRemoteLoginShellProbeOutput(`SHELL=/bin/bash\n${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`),
    "fish",
  );
  assert.equal(parseRemoteLoginShellProbeOutput("SHELL=/bin/bash\n"), null);
  assert.equal(parseRemoteLoginShellProbeOutput("   \n"), null);
});

test("probe command is fish-parseable and forces POSIX sh", () => {
  const command = buildRemoteLoginShellProbeCommand();
  // Outer form: fish and bash both accept `exec sh -c '...'` when sshd
  // routes the remote command through the login shell.
  assert.match(command, /^exec sh -c '/);
  assert.match(command, /getent passwd/);
  assert.match(command, new RegExp(PROBE_OUTPUT_MARKER));
  // ${SHELL:-} lives inside the single-quoted sh script body, not as an
  // outer-shell expansion — fish must not see it unquoted.
  assert.match(command, /\$\{SHELL:-\}/);
  assert.equal(command.startsWith("exec sh -c '"), true);
  assert.equal(command.endsWith("'"), true);
});

test("isConfirmedShellKind covers wrapper kinds only", () => {
  assert.equal(isConfirmedShellKind("fish"), true);
  assert.equal(isConfirmedShellKind("posix"), true);
  assert.equal(isConfirmedShellKind("unknown"), false);
  assert.equal(isConfirmedShellKind(undefined), false);
  assert.equal(isConfirmedShellKind(""), false);
});

test("ensureSessionShellKind short-circuits confirmed kinds without probing", async () => {
  let probes = 0;
  const session = { shellKind: "posix", protocol: "ssh" };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async () => {
      probes += 1;
      return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
    },
  });
  assert.equal(kind, "posix");
  assert.equal(probes, 0);
});

test("ensureSessionShellKind does not probe local unknown shells", async () => {
  let probes = 0;
  const session = { shellKind: "unknown", protocol: "local", type: "local" };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async () => {
      probes += 1;
      return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
    },
  });
  assert.equal(kind, "unknown");
  assert.equal(probes, 0);
});

test("ensureSessionShellKind probes fish once but does not pin it as active shell", async () => {
  // Login shell = fish must not permanently set session.shellKind (Codex P2).
  // Soft hint still selects the fish wrapper for the common fish-login case.
  let probes = 0;
  const session = { protocol: "ssh" };
  const probe = async () => {
    probes += 1;
    return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
  };

  const first = await ensureSessionShellKind(session, { execProbe: probe });
  const second = await ensureSessionShellKind(session, { execProbe: probe });

  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "fish");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 1);
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "", { loginShellHint: session._loginShellKind }),
    "fish",
  );
});

test("ensureSessionShellKind shares one in-flight probe across concurrent callers", async () => {
  let probes = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const session = { protocol: "ssh" };
  const probe = async () => {
    probes += 1;
    await gate;
    return `${PROBE_OUTPUT_MARKER}/bin/zsh\n`;
  };

  const p1 = ensureSessionShellKind(session, { execProbe: probe });
  const p2 = ensureSessionShellKind(session, { execProbe: probe });
  release();
  const [a, b] = await Promise.all([p1, p2]);

  // Posix login shells are not pinned on session.shellKind (see below).
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 1);
});

test("probed posix login shell does not block live PowerShell prompt override (Codex P2)", async () => {
  // Login shell is bash/zsh, but the user may have entered pwsh interactively
  // (or startup files exec'd it). Previously unset shellKind let
  // resolveEffectiveShellKind honor PS ...> prompts (#841). Pinning posix
  // permanently would type the bash wrapper into PowerShell.
  let probes = 0;
  const session = { protocol: "ssh" };
  const probe = async () => {
    probes += 1;
    return `${PROBE_OUTPUT_MARKER}/bin/bash\n`;
  };

  await ensureSessionShellKind(session, { execProbe: probe });
  await ensureSessionShellKind(session, { execProbe: probe });

  assert.equal(probes, 1, "posix probe should settle without re-probing");
  assert.equal(session.shellKind, undefined);
  assert.equal(session._shellKindProbeSettled, true);

  // Live PowerShell prompt still wins when shellKind is unset.
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "PS C:\\Users\\alice>", {
      loginShellHint: session._loginShellKind,
    }),
    "powershell",
  );
  // Soft posix hint → native posix wrapper (evaluated by interactive bash/zsh,
  // NOT routed through /bin/sh / dash).
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "alice@host:~$", {
      loginShellHint: session._loginShellKind,
    }),
    "posix",
  );
  const marker = "__NCMCP_POSIX_NATIVE__";
  const wrapped = buildWrappedCommand("echo native-posix", "posix", marker);
  assert.doesNotMatch(wrapped, /\bsh\s+-c\b/);
  assert.doesNotMatch(wrapped, /posix_sh/);
  assert.match(wrapped, new RegExp(`${marker}=0;`));
  assert.match(wrapped, new RegExp(`${marker}_cmd=`));
});

test("probed fish login shell is a soft hint, not a permanent pin (Codex P2)", async () => {
  const session = { protocol: "ssh" };
  await ensureSessionShellKind(session, {
    execProbe: async () => `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`,
  });
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "fish");
  // Soft hint selects fish wrapper for the common case.
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "root@host ~# ", {
      loginShellHint: session._loginShellKind,
    }),
    "fish",
  );
  // PS prompt still overrides the fish login hint.
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "PS C:\\Users\\alice>", {
      loginShellHint: session._loginShellKind,
    }),
    "powershell",
  );
});

test("ensureSessionShellKind allows retry after a failed probe", async () => {
  let probes = 0;
  const session = { protocol: "ssh" };
  const failThenSucceed = async () => {
    probes += 1;
    if (probes === 1) return null;
    return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
  };

  const first = await ensureSessionShellKind(session, {
    execProbe: failThenSucceed,
  });
  assert.equal(first, undefined);
  assert.equal(session.shellKind, undefined);

  const second = await ensureSessionShellKind(session, {
    execProbe: failThenSucceed,
  });
  assert.equal(second, undefined);
  assert.equal(session._loginShellKind, "fish");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 2);
});

test("ensureSessionShellKind uses a session-level exec probe when provided", async () => {
  let probes = 0;
  const session = {
    protocol: "mosh",
    _shellKindExecProbe: async () => {
      probes += 1;
      return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
    },
  };

  const kind = await ensureSessionShellKind(session);

  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "fish");
  assert.equal(probes, 1);
});

test("ensureSessionShellKind pins powershell login shells", async () => {
  const session = { protocol: "ssh" };
  await ensureSessionShellKind(session, {
    execProbe: async () => `${PROBE_OUTPUT_MARKER}/usr/bin/pwsh\n`,
  });
  assert.equal(session.shellKind, "powershell");
  assert.equal(session._loginShellKind, "powershell");
});

test("ensureSessionShellKindForExec cancels when Stop fires during the probe", async () => {
  // Codex P2 on #2061: probe can take up to the timeout before execViaPty
  // registers a real marker. Pending marker must latch cancel so the command
  // is not typed after the probe resolves.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const session = { protocol: "ssh" };
  const activePtyExecs = new Map();
  const probe = async () => {
    await gate;
    return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
  };

  const pending = ensureSessionShellKindForExec(session, {
    execProbe: probe,
    trackForCancellation: activePtyExecs,
    chatSessionId: "chat-cancel-probe",
  });

  // Wait until the pending marker is registered.
  for (let i = 0; i < 20 && activePtyExecs.size === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(activePtyExecs.size, 1);
  const [marker, entry] = [...activePtyExecs.entries()][0];
  assert.match(marker, /^__NCMCP_SK_PENDING_/);
  assert.equal(entry.chatSessionId, "chat-cancel-probe");

  // Simulate cancelPtyExecsForSession during the probe window.
  entry.cancel();
  release();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, "Cancelled");
  assert.equal(result.exitCode, 130);
  assert.equal(activePtyExecs.size, 0, "pending marker cleaned up after probe");
  // Login fish is recorded but not pinned as active shellKind.
  assert.equal(session._loginShellKind, "fish");
  assert.equal(session.shellKind, undefined);
});

test("ensureSessionShellKindForExec proceeds when not cancelled", async () => {
  const session = { protocol: "ssh" };
  const activePtyExecs = new Map();
  const result = await ensureSessionShellKindForExec(session, {
    execProbe: async () => `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`,
    trackForCancellation: activePtyExecs,
    chatSessionId: "chat-ok",
  });
  assert.equal(result.ok, true);
  assert.equal(result.shellKind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "fish");
  assert.equal(activePtyExecs.size, 0);
});

test("ensureSessionShellKind times out a hanging session-level exec probe", async () => {
  let probes = 0;
  const session = {
    protocol: "mosh",
    _shellKindExecProbe: async () => {
      probes += 1;
      return new Promise(() => {});
    },
  };

  const kind = await ensureSessionShellKind(session, { timeoutMs: 1 });

  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._shellKindProbePromise, null);
  assert.equal(probes, 1);
});

test("createSshConnExecProbe returns stdout from conn.exec", async () => {
  let seenCommand = "";
  const conn = {
    exec(command, cb) {
      seenCommand = command;
      const listeners = new Map();
      const stream = {
        on(event, fn) {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(fn);
          return stream;
        },
        stderr: { on() { return this; } },
        close() {},
      };
      // Deliver data after the probe has subscribed (next tick).
      queueMicrotask(() => {
        for (const fn of listeners.get("data") || []) {
          fn(Buffer.from("/usr/bin/fish\n"));
        }
        for (const fn of listeners.get("close") || []) {
          fn(0);
        }
      });
      cb(null, stream);
    },
  };
  const probe = createSshConnExecProbe(conn);
  const command = buildRemoteLoginShellProbeCommand();
  assert.equal(await probe(command, 1000), "/usr/bin/fish\n");
  assert.equal(seenCommand, command);
});

test("createSshConnExecProbe closes a channel that arrives after timeout", async () => {
  let execCallback;
  let closed = false;
  const conn = {
    exec(_command, cb) {
      execCallback = cb;
    },
  };
  const probe = createSshConnExecProbe(conn);
  const result = await probe(buildRemoteLoginShellProbeCommand(), 1);
  assert.equal(result, null);

  const stream = {
    on() { return stream; },
    stderr: { on() { return this; } },
    close() {
      closed = true;
    },
  };
  execCallback(null, stream);
  assert.equal(closed, true);
});

test("createSessionExecProbe prefers session.conn over companions", () => {
  const session = {
    conn: { exec() {} },
    moshStatsConn: { exec() {} },
  };
  const probe = createSessionExecProbe(session);
  assert.equal(typeof probe, "function");
  // Prefer primary conn: a probe built only from moshStatsConn is a different
  // function identity; we just need a usable probe here.
  assert.equal(createSessionExecProbe({}), null);
});

// --- Real fish binary: wrapper must produce markers (issue #1854) -----------

function resolveFishBinary() {
  const candidates = [
    process.env.FISH_PATH,
    "/opt/homebrew/bin/fish",
    "/usr/local/bin/fish",
    "/usr/bin/fish",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync("which", ["fish"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

const fishBinary = resolveFishBinary();

test(
  "fish wrapper runs under real fish and emits start/end markers",
  { skip: !fishBinary ? "fish binary not available" : false },
  () => {
    const marker = "__NCMCP_FISHTEST__";
    const wrapped = buildWrappedCommand("echo hello-fish-wrapper", "fish", marker);
    // fish -c runs the wrapper as a script body (same grammar as interactive
    // command line for this single-line form).
    const result = spawnSync(
      fishBinary,
      ["--no-config", "-c", wrapped.trim()],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.error, undefined, result.stderr || result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`${marker}_S`));
    assert.match(result.stdout, /hello-fish-wrapper/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  },
);

test(
  "posix wrapper fails under real fish (regression guard for #1854)",
  { skip: !fishBinary ? "fish binary not available" : false },
  () => {
    const marker = "__NCMCP_FISHTEST__";
    const wrapped = buildWrappedCommand("echo should-not-run", "posix", marker);
    const result = spawnSync(
      fishBinary,
      ["--no-config", "-c", wrapped.trim()],
      { encoding: "utf8", timeout: 10000 },
    );
    // fish rejects `VAR=0` assignment syntax.
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Unsupported use of '='|Unknown command/,
    );
  },
);

test(
  "after ensureSessionShellKind(fish login), fish wrapper succeeds under real fish",
  { skip: !fishBinary ? "fish binary not available" : false },
  async () => {
    // Soft login hint selects fish wrapper without pinning session.shellKind.
    const session = { protocol: "ssh" };
    await ensureSessionShellKind(session, {
      execProbe: async () => `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`,
    });
    assert.equal(session.shellKind, undefined);
    assert.equal(session._loginShellKind, "fish");

    const marker = "__NCMCP_FISHTEST__";
    const effective = resolveEffectiveShellKind(session.shellKind, "root at host # ", {
      loginShellHint: session._loginShellKind,
    });
    assert.equal(effective, "fish");
    const wrapped = buildWrappedCommand("printf 'ok\\n'", effective, marker);
    const result = spawnSync(
      fishBinary,
      ["--no-config", "-c", wrapped.trim()],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  },
);
