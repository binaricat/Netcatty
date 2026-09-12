const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const {
  isConfirmedShellKind,
  PROBE_OUTPUT_MARKER,
  WINDOWS_NO_DEFAULT_SHELL_MARKER,
  classifyShellKindFromRemotePath,
  buildRemoteLoginShellProbeCommand,
  buildRemoteWindowsLoginShellProbeCommand,
  parseRemoteLoginShellProbeOutput,
  parseRemoteWindowsLoginShellProbeOutput,
  isWindowsOpenSshRemote,
  remoteDisallowsExecChannelProbe,
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
  assert.equal(
    classifyShellKindFromRemotePath(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ),
    "powershell",
  );
  assert.equal(
    classifyShellKindFromRemotePath("C:\\Windows\\System32\\cmd.exe"),
    "cmd",
  );
  assert.equal(classifyShellKindFromRemotePath("/usr/bin/nu"), null);
  assert.equal(classifyShellKindFromRemotePath(""), null);
});

test("isWindowsOpenSshRemote matches OpenSSH_for_Windows banners", () => {
  assert.equal(isWindowsOpenSshRemote("OpenSSH_for_Windows_9.5"), true);
  assert.equal(isWindowsOpenSshRemote("SSH-2.0-OpenSSH_for_Windows_8.1"), true);
  assert.equal(isWindowsOpenSshRemote("OpenSSH_9.6"), false);
  assert.equal(isWindowsOpenSshRemote(""), false);
  assert.equal(isWindowsOpenSshRemote(undefined), false);
});

test("Windows login-shell probe uses reg query for DefaultShell", () => {
  const command = buildRemoteWindowsLoginShellProbeCommand();
  assert.match(command, /reg query/i);
  assert.match(command, /HKLM\\SOFTWARE\\OpenSSH/i);
  assert.match(command, /DefaultShell/);
  // Force cmd.exe so ERRORLEVEL works under powershell DefaultShell too.
  assert.match(command, /cmd\.exe/i);
  // Missing-value marker only after confirming the OpenSSH key is readable
  // (`if not errorlevel 1`), not on every reg failure (access denied / missing
  // key under a readable parent). Parent SOFTWARE readability must not imply
  // OpenSSH absence — ACL is per-key.
  assert.match(command, /if errorlevel 1/i);
  assert.match(command, /if not errorlevel 1/i);
  assert.doesNotMatch(command, /HKLM\\SOFTWARE(?!\\OpenSSH)/);
  assert.match(command, new RegExp(WINDOWS_NO_DEFAULT_SHELL_MARKER));
  // Missing DefaultShell diagnostics may still land on stderr; redirect keeps
  // REG_SZ success lines visible when hosts split streams.
  assert.match(command, /2>&1/);
});

test("parseRemoteWindowsLoginShellProbeOutput reads DefaultShell and missing-key default", () => {
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput(
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\r\n    DefaultShell    REG_SZ    C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n",
    ),
    "powershell",
  );
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput(
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\r\n    DefaultShell    REG_SZ    C:\\Windows\\System32\\cmd.exe\r\n",
    ),
    "cmd",
  );
  // Locale-independent marker from ERRORLEVEL (preferred path): OpenSSH key
  // readable, DefaultShell value absent.
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput(
      `错误: 系统找不到指定的注册表项或值。\r\n${WINDOWS_NO_DEFAULT_SHELL_MARKER}\r\n`,
    ),
    "cmd",
  );
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput(
      `${WINDOWS_NO_DEFAULT_SHELL_MARKER}\r\n`,
    ),
    "cmd",
  );
  // English diagnostic kept as fallback for older fixtures / probe output.
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput(
      "ERROR: The system was unable to find the specified registry key or value.\r\n",
    ),
    "cmd",
  );
  // Localized text alone must not classify — that was the P2 hang risk.
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput("错误: 系统找不到指定的注册表项或值。\r\n"),
    null,
  );
  // Access denied / policy blocks must stay unclassified (no missing-value
  // marker). Treating them as cmd permanently pins the wrong wrapper on
  // PowerShell DefaultShell hosts.
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput("ERROR: Access is denied.\r\n"),
    null,
  );
  assert.equal(
    parseRemoteWindowsLoginShellProbeOutput("错误: 拒绝访问。\r\n"),
    null,
  );
  assert.equal(parseRemoteWindowsLoginShellProbeOutput(""), null);
  assert.equal(parseRemoteWindowsLoginShellProbeOutput("reg: command not found\n"), null);
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

test("ensureSessionShellKind soft-hints powershell login shells without pinning", async () => {
  const session = { protocol: "ssh" };
  await ensureSessionShellKind(session, {
    execProbe: async () => `${PROBE_OUTPUT_MARKER}/usr/bin/pwsh\n`,
  });
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "powershell");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "", {
      loginShellHint: session._loginShellKind,
    }),
    "powershell",
  );
  // Live cmd prompt overrides a PowerShell DefaultShell soft hint.
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "C:\\Users\\alice>", {
      loginShellHint: session._loginShellKind,
    }),
    "cmd",
  );
  // Live POSIX prompt (WSL) overrides a PowerShell soft hint.
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "user@host:~$", {
      loginShellHint: session._loginShellKind,
    }),
    "posix",
  );
});

test("ensureSessionShellKind uses Windows DefaultShell probe for OpenSSH_for_Windows", async () => {
  // Issue #2959: Unix `exec sh -c` probes never classify Windows OpenSSH, so AI
  // fell through to a posix wrapper, hung, and Stop/Ctrl+C tore down the tab.
  const probed = [];
  const session = {
    protocol: "ssh",
    remoteSshVersion: "OpenSSH_for_Windows_9.5",
  };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async (command) => {
      probed.push(command);
      return (
        "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\r\n" +
        "    DefaultShell    REG_SZ    C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n"
      );
    },
  });
  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "powershell");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probed.length, 1);
  assert.match(probed[0], /reg query/i);
  assert.doesNotMatch(probed[0], /getent passwd/);
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "", {
      loginShellHint: session._loginShellKind,
    }),
    "powershell",
  );
});

test("ensureSessionShellKind soft-hints cmd when Windows OpenSSH has no DefaultShell value", async () => {
  const session = {
    protocol: "ssh",
    remoteSshVersion: "OpenSSH_for_Windows_8.1",
  };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async () =>
      `错误: 系统找不到指定的注册表项或值。\r\n${WINDOWS_NO_DEFAULT_SHELL_MARKER}\r\n`,
  });
  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "cmd");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "", {
      loginShellHint: session._loginShellKind,
    }),
    "cmd",
  );
  // Live PowerShell prompt overrides a cmd DefaultShell soft hint.
  assert.equal(
    resolveEffectiveShellKind(session.shellKind, "PS C:\\Users\\alice>", {
      loginShellHint: session._loginShellKind,
    }),
    "powershell",
  );
});

test("ensureSessionShellKind does not pin cmd when Windows reg probe is access-denied", async () => {
  // Codex P2: access denied must not share the missing-value → cmd path.
  let probes = 0;
  const session = {
    protocol: "ssh",
    remoteSshVersion: "OpenSSH_for_Windows_9.5",
  };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async () => {
      probes += 1;
      // Live probe no longer echoes WINDOWS_NO_DEFAULT_SHELL_MARKER here.
      return "ERROR: Access is denied.\r\n";
    },
  });
  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 1);
});

test("ensureSessionShellKind settles Windows OpenSSH without pinning when reg probe is empty", async () => {
  let probes = 0;
  const session = {
    protocol: "ssh",
    remoteSshVersion: "OpenSSH_for_Windows_9.5",
  };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async () => {
      probes += 1;
      return "";
    },
  });
  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 1);

  // Settled: do not re-probe on the next AI exec.
  await ensureSessionShellKind(session, {
    execProbe: async () => {
      probes += 1;
      return "";
    },
  });
  assert.equal(probes, 1);
});

test("ensureSessionShellKind retries Windows OpenSSH probe after null/timeout", async () => {
  // Codex P1: timeout/channel failure must not settleWithoutKind — otherwise
  // later AI execs permanently use the POSIX wrapper on Windows.
  let probes = 0;
  const session = {
    protocol: "ssh",
    remoteSshVersion: "OpenSSH_for_Windows_9.5",
  };
  const failThenSucceed = async () => {
    probes += 1;
    if (probes === 1) return null;
    return (
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\r\n" +
      "    DefaultShell    REG_SZ    C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n"
    );
  };

  const first = await ensureSessionShellKind(session, {
    execProbe: failThenSucceed,
  });
  assert.equal(first, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._shellKindProbeSettled, undefined);
  assert.equal(session._shellKindProbePromise, null);

  const second = await ensureSessionShellKind(session, {
    execProbe: failThenSucceed,
  });
  assert.equal(second, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "powershell");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 2);
});

test("ensureSessionShellKind falls back to Windows reg probe when Unix probe yields nothing", async () => {
  const probed = [];
  const session = { protocol: "ssh" };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async (command) => {
      probed.push(command);
      if (/reg query/i.test(command)) {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\n" +
          "    DefaultShell    REG_SZ    C:\\Windows\\System32\\cmd.exe\n"
        );
      }
      return "no marker here\n";
    },
  });
  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, "cmd");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probed.length, 2);
  assert.match(probed[0], /getent passwd|exec sh -c/);
  assert.match(probed[1], /reg query/i);
});

test("ensureSessionShellKind settles completed unclassifiable Windows fallback without re-probing", async () => {
  // Codex P2: when remoteSshVersion is missing, Unix probe returns non-marker
  // bytes, and Windows reg returns access-denied, settle so later AI execs do
  // not re-run both probes forever. Null/timeout still retries.
  let probes = 0;
  const session = { protocol: "ssh" };
  const kind = await ensureSessionShellKind(session, {
    execProbe: async (command) => {
      probes += 1;
      if (/reg query/i.test(command)) {
        return "ERROR: Access is denied.\r\n";
      }
      return "no marker here\n";
    },
  });
  assert.equal(kind, undefined);
  assert.equal(session.shellKind, undefined);
  assert.equal(session._loginShellKind, undefined);
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 2);

  await ensureSessionShellKind(session, {
    execProbe: async () => {
      probes += 1;
      return "should not run\n";
    },
  });
  assert.equal(probes, 2);
});

test("ensureSessionShellKind retries Windows fallback after null/timeout when banner missing", async () => {
  let probes = 0;
  const session = { protocol: "ssh" };
  const first = await ensureSessionShellKind(session, {
    execProbe: async (command) => {
      probes += 1;
      if (/reg query/i.test(command)) return null;
      return "no marker here\n";
    },
  });
  assert.equal(first, undefined);
  assert.equal(session._shellKindProbeSettled, undefined);
  assert.equal(session._shellKindProbePromise, null);
  assert.equal(probes, 2);

  const second = await ensureSessionShellKind(session, {
    execProbe: async (command) => {
      probes += 1;
      if (/reg query/i.test(command)) {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\n" +
          "    DefaultShell    REG_SZ    C:\\Windows\\System32\\cmd.exe\n"
        );
      }
      return "no marker here\n";
    },
  });
  assert.equal(second, undefined);
  assert.equal(session._loginShellKind, "cmd");
  assert.equal(session._shellKindProbeSettled, true);
  assert.equal(probes, 4);
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

test("createSshConnExecProbe includes stderr so missing DefaultShell is classifiable", async () => {
  // Codex P1: reg.exe writes the missing-value error only on stderr. Dropping
  // it made Windows OpenSSH probes settle without a kind and hang on POSIX
  // wrappers when the interactive prompt was unrecognized.
  // Codex P2: the live probe also echoes WINDOWS_NO_DEFAULT_SHELL_MARKER via
  // ERRORLEVEL so non-English hosts do not depend on localized stderr text.
  const { EventEmitter } = require("node:events");
  const conn = {
    exec(_command, cb) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      queueMicrotask(() => {
        stream.stderr.emit(
          "data",
          Buffer.from("错误: 系统找不到指定的注册表项或值。\r\n"),
        );
        stream.emit("data", Buffer.from(`${WINDOWS_NO_DEFAULT_SHELL_MARKER}\r\n`));
        stream.emit("close", 1);
      });
      cb(null, stream);
    },
  };
  const probe = createSshConnExecProbe(conn);
  const output = await probe(buildRemoteWindowsLoginShellProbeCommand(), 1000);
  assert.match(output, new RegExp(WINDOWS_NO_DEFAULT_SHELL_MARKER));
  assert.equal(parseRemoteWindowsLoginShellProbeOutput(output), "cmd");
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

test("remoteDisallowsExecChannelProbe flags bastion banners that drop a second channel (#3146)", () => {
  assert.equal(remoteDisallowsExecChannelProbe("BHostSSH_7.0"), true);
  assert.equal(remoteDisallowsExecChannelProbe("TERM-SSHD"), true);
  assert.equal(remoteDisallowsExecChannelProbe("OpenSSH_9.6"), false);
  assert.equal(remoteDisallowsExecChannelProbe("dropbear_2022.83"), false);
  assert.equal(remoteDisallowsExecChannelProbe("OpenSSH_for_Windows_9.5"), false);
  assert.equal(remoteDisallowsExecChannelProbe(undefined), false);
  assert.equal(remoteDisallowsExecChannelProbe(""), false);
});

test("createSessionExecProbe skips the exec channel on bastions so AI exec does not disconnect (#3146)", () => {
  const session = {
    remoteSshVersion: "BHostSSH_7.0",
    conn: { exec() {} },
  };
  assert.equal(createSessionExecProbe(session), null);
});

test("ensureSessionShellKind does not exec-probe bastions (#3146)", async () => {
  let execCalls = 0;
  const session = {
    protocol: "ssh",
    remoteSshVersion: "BHostSSH_7.0",
    conn: {
      exec() {
        execCalls += 1;
      },
    },
  };
  const kind = await ensureSessionShellKind(session);
  assert.equal(kind, undefined);
  assert.equal(execCalls, 0, "bastion must never open a second SSH channel");
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
