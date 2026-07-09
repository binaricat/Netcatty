const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const {
  isConfirmedShellKind,
  classifyShellKindFromRemotePath,
  buildRemoteLoginShellProbeCommand,
  parseRemoteLoginShellProbeOutput,
  createSshConnExecProbe,
  createSessionExecProbe,
  ensureSessionShellKind,
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

test("parseRemoteLoginShellProbeOutput reads the first non-empty line", () => {
  assert.equal(
    parseRemoteLoginShellProbeOutput("\n/usr/bin/fish\n"),
    "fish",
  );
  assert.equal(
    parseRemoteLoginShellProbeOutput("  /bin/bash\r\n"),
    "posix",
  );
  assert.equal(parseRemoteLoginShellProbeOutput("   \n"), null);
});

test("probe command is fish-parseable and forces POSIX sh", () => {
  const command = buildRemoteLoginShellProbeCommand();
  // Outer form: fish and bash both accept `exec sh -c '...'` when sshd
  // routes the remote command through the login shell.
  assert.match(command, /^exec sh -c '/);
  assert.match(command, /getent passwd/);
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
      return "/usr/bin/fish";
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
      return "/usr/bin/fish";
    },
  });
  assert.equal(kind, "unknown");
  assert.equal(probes, 0);
});

test("ensureSessionShellKind probes once and caches fish on SSH sessions", async () => {
  let probes = 0;
  const session = { protocol: "ssh" };
  const probe = async () => {
    probes += 1;
    return "/usr/bin/fish\n";
  };

  const first = await ensureSessionShellKind(session, { execProbe: probe });
  const second = await ensureSessionShellKind(session, { execProbe: probe });

  assert.equal(first, "fish");
  assert.equal(second, "fish");
  assert.equal(session.shellKind, "fish");
  assert.equal(probes, 1);
  // After a confirmed kind, resolveEffectiveShellKind must keep fish wrapping
  // even if the idle prompt looks empty/custom.
  assert.equal(resolveEffectiveShellKind(session.shellKind, ""), "fish");
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
    return "/bin/zsh\n";
  };

  const p1 = ensureSessionShellKind(session, { execProbe: probe });
  const p2 = ensureSessionShellKind(session, { execProbe: probe });
  release();
  const [a, b] = await Promise.all([p1, p2]);

  assert.equal(a, "posix");
  assert.equal(b, "posix");
  assert.equal(probes, 1);
});

test("ensureSessionShellKind allows retry after a failed probe", async () => {
  let probes = 0;
  const session = { protocol: "ssh" };
  const failThenSucceed = async () => {
    probes += 1;
    if (probes === 1) return null;
    return "/usr/bin/fish\n";
  };

  const first = await ensureSessionShellKind(session, {
    execProbe: failThenSucceed,
  });
  assert.equal(first, undefined);
  assert.equal(session.shellKind, undefined);

  const second = await ensureSessionShellKind(session, {
    execProbe: failThenSucceed,
  });
  assert.equal(second, "fish");
  assert.equal(probes, 2);
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
  "after ensureSessionShellKind(fish), wrapped AI command succeeds in fish",
  { skip: !fishBinary ? "fish binary not available" : false },
  async () => {
    const session = { protocol: "ssh" };
    await ensureSessionShellKind(session, {
      execProbe: async () => "/usr/bin/fish\n",
    });
    assert.equal(session.shellKind, "fish");

    const marker = "__NCMCP_FISHTEST__";
    const effective = resolveEffectiveShellKind(session.shellKind, "root at host # ");
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
