const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  resolveEffectiveShellKind,
  execViaChannel,
} = require("./ptyExec.cjs");
const {
  buildWrappedCommand,
} = require("./ptyExecHelpers.cjs");

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function shellAvailable(command) {
  const result = spawnSync(command, ["-c", ":"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

const HAS_BASH = process.platform !== "win32" && commandAvailable("bash");
const HAS_ZSH = process.platform !== "win32" && commandAvailable("zsh");
const HAS_DASH = process.platform !== "win32" && shellAvailable("dash");

test("uses PowerShell wrapping when a session with no confirmed shell sees a PowerShell prompt", () => {
  // SSH sessions don't set shellKind (sshBridge never assigns one), which
  // is exactly the issue #841 case the override targets.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("uses PowerShell wrapping when shellKind is 'unknown'", () => {
  assert.equal(
    resolveEffectiveShellKind("unknown", "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("does NOT override an explicit non-PowerShell shell kind even if the prompt looks like PowerShell", () => {
  // Defends against a malicious remote process spoofing a `PS ...>` line
  // on a real bash/zsh/cmd/fish/raw session to coerce a single
  // mis-wrapped command.
  assert.equal(
    resolveEffectiveShellKind("posix", "PS C:\\Users\\alice>"),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind("fish", "PS C:\\Users\\alice>"),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind("cmd", "PS C:\\Users\\alice>"),
    "cmd",
  );
  assert.equal(
    resolveEffectiveShellKind("raw", "PS C:\\Users\\alice>"),
    "raw",
  );
});

test("keeps powershell wrapping for an explicit powershell session even when nested into a non-PS shell", () => {
  // After `wsl` or similar, a confirmed PowerShell session may show a
  // posix prompt. We currently keep PowerShell wrapping (the user's
  // configured shell is the source of truth). Reverse detection would
  // be a separate feature; this test locks the current behavior so a
  // future change is intentional.
  assert.equal(
    resolveEffectiveShellKind("powershell", "alice@host:~$"),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind("powershell", ""),
    "powershell",
  );
});

test("recognizes a PowerShell prompt that has trailing whitespace", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>   "),
    "powershell",
  );
});

test("recognizes a bare PowerShell prompt without a working directory", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PS>"), "powershell");
});

test("recognizes PowerShell on Linux/macOS prompts (`PS /home/alice>`)", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS /home/alice>"),
    "powershell",
  );
});

test("ignores ANSI-coloured PowerShell prompts when detecting the shell", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "[32mPS C:\\Users\\alice>[0m"),
    "powershell",
  );
});

test("treats a CR-redrawn last line as the effective prompt, not the doubled string", () => {
  // PSReadLine / ConPTY emit `\r` to repaint the current line. Without
  // CR-as-newline normalization the regex would match a doubled prompt
  // string that never round-trips through the live PTY tail.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\old>\rPS C:\\new>"),
    "powershell",
  );
});

test("rejects spoofed `PS >` (literal space then `>`) — default PowerShell never emits this", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PS >"), "posix");
});

test("falls back to posix when neither shell kind nor prompt is informative", () => {
  assert.equal(resolveEffectiveShellKind(undefined, ""), "posix");
  assert.equal(resolveEffectiveShellKind(null, undefined), "posix");
});

test("does not misclassify command output that happens to contain 'PS'", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PSO>"), "posix");
  assert.equal(resolveEffectiveShellKind(undefined, "ZIPS>"), "posix");
});

test("cmd wrapper uses interactive cmd variable expansion", () => {
  const wrapped = buildWrappedCommand("ipconfig /all", "cmd", "__NCMCP_TEST__");
  assert.match(wrapped, /"%__NCMCP_TEST___CMD%"/);
  assert.doesNotMatch(wrapped, /"%%__NCMCP_TEST___CMD%%"/);
});

test("posix wrapper isolates set -e failures from the parent login shell", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("  set -e\nfalse\necho SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper keeps non-exiting state changes in the parent shell", () => {
  const marker = "__NCMCP_TEST__";
  const cwd = mkdtempSync(join(tmpdir(), "netcatty-pty-cd-"));
  try {
    const wrapped = buildWrappedCommand(`cd '${cwd.replace(/'/g, "'\\''")}'`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}pwd`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("posix wrapper keeps safe state changes inside control structures", () => {
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-control-state-"));
  try {
    for (const [name, command, expectedPattern] of [
      ["if_cd", `if true; then cd '${dir.replace(/'/g, "'\\''")}'; fi`, new RegExp(`PWD=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)],
      ["case_export", "case x in x) export NETCATTY_CASE_EXPORT=ok;; esac", /VALUE=ok/],
      ["loop_export", "for x in y; do export NETCATTY_LOOP_EXPORT=ok; done", /VALUE=ok/],
    ]) {
      const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
      const wrapped = buildWrappedCommand(command, "posix", marker);
      const result = spawnSync("sh", ["-c", `${wrapped}printf 'PWD=%s VALUE=%s%s\\n' "$PWD" "$NETCATTY_CASE_EXPORT" "$NETCATTY_LOOP_EXPORT"`], {
        encoding: "utf8",
        env: {
          ...process.env,
          SHELL: "/bin/sh",
        },
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`${marker}_E:0`));
      assert.match(result.stdout, expectedPattern);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper emits markers in dash-backed POSIX shells", { skip: !HAS_DASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf DASH_OK", "posix", marker);
  const result = spawnSync("dash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DASH_OK/);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper emits markers in dash when parent errexit is active", { skip: !HAS_DASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf DASH_ERREXIT_OK", "posix", marker);
  const result = spawnSync("dash", ["-c", `set -e; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DASH_ERREXIT_OK/);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper survives a failing command when parent errexit is already active", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("false", "posix", marker);
  const result = spawnSync("sh", ["-c", `set -e; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates nounset exits from the parent shell", () => {
  for (const [name, setup, command] of [
    ["command_sets_nounset", "", "set -u; echo $NETCATTY_MISSING_NOUNSET; echo SHOULD_NOT_PRINT"],
    ["parent_has_nounset", "set -u; ", "echo $NETCATTY_MISSING_NOUNSET; echo SHOULD_NOT_PRINT"],
    ["parent_has_nounset_positional", "set -u; ", "export NETCATTY_FROM_POSITIONAL=$1; echo SHOULD_NOT_PRINT"],
    ["parent_has_nounset_braced_positional", "set -u; ", "export NETCATTY_FROM_BRACED=${1}; echo SHOULD_NOT_PRINT"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${setup}${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_S`));
    assert.match(result.stdout, new RegExp(`${marker}_E:2|${marker}_E:1`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
  }
});

test("posix wrapper emits markers in dash when parent nounset is active", { skip: !HAS_DASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf DASH_NOUNSET_OK", "posix", marker);
  const result = spawnSync("dash", ["-c", `set -u; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DASH_NOUNSET_OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper emits markers in zsh when parent nounset is active", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf ZSH_NOUNSET_OK", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `set -u; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ZSH_NOUNSET_OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates inside the current shell instead of SHELL env", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("set -e\n[[ 1 == 1 ]] && echo BASH_OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /BASH_OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper emits the end marker on a fresh line after exec without trailing newline", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("exec printf OK", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.match(result.stdout, new RegExp(`OK\\n${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates exit inside shell control structures", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("if true; then exit 7; fi", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:7`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates exit behind leading fd redirections", () => {
  for (const [name, command, code] of [
    ["stderr_to_stdout", "2>&1 exit 7", 7],
    ["fd_to_stdout", "3>&1 exit 8", 8],
    ["stdin_dup", "2<&0 exit 9", 9],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:${code}`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper isolates exit inside loop and case structures", () => {
  for (const [name, command, code] of [
    ["while", "while true; do exit 8; done", 8],
    ["case", "case x in x) exit 9;; esac", 9],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:${code}`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper isolates exec invoked through command", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("command exec printf OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`OK\\n${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates exec invoked through builtin", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("builtin exec printf OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`OK\\n${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper ignores quoted risky-looking text when preserving state", () => {
  const marker = "__NCMCP_TEST__";
  const cwd = mkdtempSync(join(tmpdir(), "netcatty-pty-quoted-"));
  try {
    const wrapped = buildWrappedCommand(`cd '${cwd.replace(/'/g, "'\\''")}' && echo '; exit'`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}pwd`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.match(result.stdout, /; exit/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("posix wrapper blocks self-kill commands instead of running them", () => {
  for (const [name, command] of [
    ["pid", "kill -TERM $$"],
    ["group", "kill 0"],
    ["group_00", "kill 00"],
    ["group_plus_0", "kill +0"],
    ["group_minus_00", "kill -TERM -00"],
    ["group_negative", "kill -- -1"],
    ["group_negative_with_signal", "kill -TERM -1234"],
    ["path", "/bin/kill -TERM $$"],
    ["env", "env kill -TERM $$"],
    ["env_path", "/usr/bin/env kill -TERM 0"],
    ["env_unset", "env -u FOO kill -TERM 0"],
    ["env_chdir", "env -C /tmp kill -TERM 0"],
    ["env_dash", "env - kill -TERM 0"],
    ["env_path", "env -P /bin kill -TERM 0"],
    ["env_i_split", "env -iS 'kill -TERM 0'"],
    ["env_split", "env -S 'kill -TERM 0'"],
    ["shell_c", "sh -c 'kill -TERM $$'"],
    ["shell_ec", "sh -ec 'kill -TERM 0'"],
    ["shell_lc", "bash -lc 'kill -TERM 0'"],
    ["shell_option_arg", "bash -O extglob -c 'kill -TERM 0'"],
    ["time_option", "time -p kill -TERM 0"],
    ["command_option", "command -p kill -TERM 0"],
    ["nice", "nice kill -TERM 0"],
    ["nohup", "nohup kill -TERM 0"],
    ["timeout", "timeout 2 kill -TERM $$"],
    ["stdbuf", "stdbuf -oL kill -TERM 0"],
    ["stdbuf_long_output", "stdbuf --output L kill -TERM 0"],
    ["setsid", "setsid kill -TERM 0"],
    ["flock", "flock /tmp/netcatty-pty-test.lock kill -TERM 0"],
    ["flock_long_timeout", "flock --timeout 1 /tmp/netcatty-pty-test.lock kill -TERM 0"],
    ["flock_command", "flock -c 'kill -TERM 0' /tmp/netcatty-pty-test.lock"],
    ["coproc", "coproc kill -TERM 0"],
    ["python_parent_pid", "python3 -c \"import os,signal; os.kill($$, signal.SIGTERM)\""],
    ["python_getppid", "python3 -c 'import os,signal; os.kill(os.getppid(), signal.SIGTERM)'"],
    ["python_group_kill", "python3 -c 'import os,signal; os.kill(0, signal.SIGTERM)'"],
    ["python_getpgrp", "python3 -c 'import os,signal; os.kill(os.getpgrp(), signal.SIGTERM)'"],
    ["node_group_kill", "node -e 'process.kill(0, \"SIGTERM\")'"],
    ["node_parent_kill", "node -e 'process.kill(process.ppid, \"SIGTERM\")'"],
    ["perl_group_kill", "perl -e 'kill TERM, 0'"],
    ["perl_parent_kill", "perl -e 'kill TERM, getppid'"],
    ["perl_getpgrp", "perl -e 'kill TERM, getpgrp'"],
    ["ruby_group_kill", "ruby -e 'Process.kill(\"TERM\", 0)'"],
    ["ruby_parent_kill", "ruby -e 'Process.kill(\"TERM\", Process.ppid)'"],
    ["ruby_getpgrp", "ruby -e 'Process.kill(\"TERM\", Process.getpgrp)'"],
    ["xargs_kill_pid", "printf '%s\\n' $$ | xargs kill -TERM"],
    ["xargs_kill_group", "printf '%s\\n' 0 | xargs kill -TERM"],
    ["xargs_shell_group", "printf x | xargs sh -c 'kill -TERM 0'"],
    ["find_exec_kill_group", "find . -maxdepth 0 -exec kill -TERM 0 \\;"],
    ["find_exec_shell_group", "find . -maxdepth 0 -exec sh -c 'kill -TERM 0' \\;"],
    ["function_call", "bye(){ kill -TERM $$; }; bye"],
    ["backtick", "echo `kill -TERM $$`"],
    ["dollar_paren", "echo $(kill -TERM $$)"],
    ["nested_dollar_paren", "echo $(echo $(kill -TERM $$))"],
    ["backtick_command", "`printf kill` -TERM $$"],
    ["backtick_target", "kill -TERM `printf 0`"],
    ["eval", "eval 'kill -TERM $$'"],
    ["eval_dynamic", "x='kill -TERM $$'; eval \"$x\""],
    ["source", ". /tmp/netcatty-unsafe-source"],
    ["redirect", ">/dev/null kill -TERM $$"],
    ["multiline", "echo FIRST\nkill -TERM $$"],
    ["dynamic", "x=kill; $x -TERM $$"],
    ["dynamic_pid", "p=$$; kill -TERM $p"],
    ["dynamic_group", "p=0; kill -TERM $p"],
    ["dynamic_exit", "x=exit; $x 11"],
    ["dynamic_exec", "x=exec; $x printf OK"],
    ["risky_alias", "alias bye='exit 7'; bye"],
    ["trap_debug_exit", "trap 'exit 17' DEBUG"],
    ["trap_debug_kill", "trap 'kill -TERM $$' DEBUG; echo OK"],
    ["trap_debug_int_exit", "trap 'exit 17' DEBUG INT"],
    ["trap_debug_int_kill", "trap 'kill -TERM $$' DEBUG INT"],
    ["trap_int_exit", "trap 'exit 17' INT; echo OK"],
    ["trap_exit_exit", "trap 'exit 17' EXIT; echo OK"],
    ["trap_zero_kill", "trap 'kill -TERM $$' 0; echo OK"],
    ["trap_term_exit", "trap 'exit 17' TERM; echo OK"],
    ["trap_int_reset_then_sleep", "trap INT; sleep 1"],
    ["trap_sigint_reset_then_sleep", "trap -- SIGINT; sleep 1"],
    ["trap_numeric_int_reset_then_sleep", "trap 2; sleep 1"],
    ["trap_debug_lower", "trap 'kill -TERM $$' debug"],
    ["trap_err_lower", "trap 'kill -TERM $$' err; false"],
    ["trap_zerr", "trap 'kill -TERM 0' ZERR; false"],
    ["trap_debug_dynamic", "trap 'x=exit; $x 17' DEBUG"],
    ["trap_debug_variable_handler", "x='kill -TERM $$'; trap \"$x\" DEBUG"],
    ["trap_debug_eval_handler", "x='kill -TERM $$'; trap 'eval \"$x\"' DEBUG"],
    ["trap_debug_substitution", "trap '$(kill -TERM $$)' DEBUG"],
    ["prefix_function_timeout", "timeout(){ kill -TERM 0; }; timeout 1 printf OK"],
    ["prefix_function_command", "command(){ kill -TERM 0; }; command printf OK"],
    ["readonly_internal", "readonly __NCMCP_rc=0"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper allows harmless nested shell command strings", { skip: !HAS_BASH }, () => {
  for (const [name, command] of [
    ["sh_c", "sh -c 'printf SAFE'"],
    ["bash_lc", "bash -lc 'printf SAFE'"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("bash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, /SAFE/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper recognizes versioned script interpreter names", () => {
  const pythonPath = spawnSync("sh", ["-c", "command -v python3"], {
    encoding: "utf8",
  }).stdout.trim();
  if (!pythonPath) return;

  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-python-"));
  const versionedPythonPath = join(dir, "python3.11");
  try {
    symlinkSync(pythonPath, versionedPythonPath);
    const command = `'${versionedPythonPath.replace(/'/g, "'\\''")}' -c 'import os,signal; os.kill(0, signal.SIGTERM)'`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper allows reading the current shell pid", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("echo $$", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper preserves state through command prefix options", { skip: !HAS_BASH }, () => {
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-command-prefix-"));
  try {
    for (const [name, command, expected] of [
      ["command_p_cd", `command -p cd '${dir.replace(/'/g, "'\\''")}'`, dir],
      ["command_dashdash_cd", `command -- cd '${dir.replace(/'/g, "'\\''")}'`, dir],
      ["command_export", "command export NETCATTY_COMMAND_PREFIX=ok", "ok"],
    ]) {
      const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
      const wrapped = buildWrappedCommand(command, "posix", marker);
      const result = spawnSync("bash", ["-c", `${wrapped}printf 'PWD=%s VALUE=%s\\n' "$PWD" "$NETCATTY_COMMAND_PREFIX"`], {
        encoding: "utf8",
        env: {
          ...process.env,
          SHELL: "/bin/false",
        },
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
      assert.match(result.stdout, new RegExp(`${marker}_E:0`));
      assert.match(result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper keeps safe source state but blocks unsafe source files", () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-safe-source-"));
  const scriptPath = join(dir, "env file.sh");
  try {
    writeFileSync(scriptPath, "export NETCATTY_SAFE_SOURCE=ok\nexport NETCATTY_SOURCE_PATH=.:$PATH:/netcatty\nexport NETCATTY_DOT=.\n");
    const wrapped = buildWrappedCommand(`. '${scriptPath.replace(/'/g, "'\\''")}'`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'SOURCE=%s\\nPATH=%s\\n' "$NETCATTY_SAFE_SOURCE" "$NETCATTY_SOURCE_PATH"`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /SOURCE=ok/);
    assert.match(result.stdout, /netcatty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper keeps multiple safe source files in zsh", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-zsh-source-"));
  const firstPath = join(dir, "first.sh");
  const secondPath = join(dir, "second.sh");
  try {
    writeFileSync(firstPath, "export NETCATTY_ZSH_SOURCE_ONE=one\n");
    writeFileSync(secondPath, "export NETCATTY_ZSH_SOURCE_TWO=two\n");
    const command = `. '${firstPath.replace(/'/g, "'\\''")}'; . '${secondPath.replace(/'/g, "'\\''")}'`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'ONE=%s TWO=%s\\n' "$NETCATTY_ZSH_SOURCE_ONE" "$NETCATTY_ZSH_SOURCE_TWO"`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /ONE=one TWO=two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper blocks source files before they can exit the parent", () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-source-"));
  const scriptPath = join(dir, "exit.sh");
  try {
    writeFileSync(scriptPath, "exit 7\n");
    const wrapped = buildWrappedCommand(`. '${scriptPath.replace(/'/g, "'\\''")}'`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper blocks source files with dynamic shell-terminating commands", () => {
  for (const [name, content] of [
    ["dynamic_exit", "x=exit; $x 7\n"],
    ["dynamic_set", "opt=-e; set $opt; false\n"],
    ["trap_debug", "trap 'exit 9' DEBUG\n"],
    ["eval", "eval 'exit 8'\n"],
    ["setopt_errexit", "setopt err_exit\n"],
    ["setopt_upper_errexit", "setopt ERR_EXIT\n"],
    ["dangerous_alias", "alias bye='exit 7'\n"],
    ["dangerous_alias_path_kill", "alias bye='/bin/kill -TERM 0'\n"],
    ["dangerous_alias_path_signal_kill", "alias bye='/bin/kill -s TERM 0'\n"],
    ["dangerous_alias_path_signal_number_kill", "alias bye='/bin/kill -n 15 0'\n"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-source-risk-"));
    const scriptPath = join(dir, "risk.sh");
    try {
      writeFileSync(scriptPath, content);
      const wrapped = buildWrappedCommand(`. '${scriptPath.replace(/'/g, "'\\''")}'`, "posix", marker);
      const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
        encoding: "utf8",
        env: {
          ...process.env,
          SHELL: "/bin/sh",
        },
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
      assert.match(result.stdout, new RegExp(`${marker}_E:126`));
      assert.match(result.stdout, /PARENT_STILL_ALIVE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("posix wrapper blocks source files with assignment-prefixed path kill", () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-source-path-kill-"));
  const scriptPath = join(dir, "risk.sh");
  try {
    writeFileSync(scriptPath, "FOO=bar /bin/kill -TERM 0\n");
    const wrapped = buildWrappedCommand(`. '${scriptPath.replace(/'/g, "'\\''")}'`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      detached: true,
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper isolates eval and shell command prefixes that can exit", () => {
  for (const [name, command, code] of [
    ["function_call", "bye(){ exit 5; }; bye", 5],
    ["multiline_exit", "echo FIRST\nexit 6", 6],
    ["bang_exit", "! exit 8", 8],
    ["time_exit", "time exit 9", 9],
    ["redirect_exit", ">/dev/null exit 10", 10],
    ["command_set", "command set -e; false; echo SHOULD_NOT_PRINT", 1],
    ["dynamic_set", "opt=-e; set $opt; false; echo SHOULD_NOT_PRINT", 1],
    ["dynamic_errexit", "opt=errexit; set -o $opt; false; echo SHOULD_NOT_PRINT", 1],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:${code}`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
  }
});

test("posix wrapper keeps export state when command substitution exits", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("export X=$(printf ok; exit 7)", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'X=%s\\n' \"$X\"`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /X=ok/);
});

test("posix wrapper blocks existing shell functions before they can exit the parent", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("bye", "posix", marker);
  const result = spawnSync("sh", ["-c", `bye(){ exit 7; }; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper blocks dangerous existing aliases", { skip: !HAS_BASH }, () => {
  for (const [name, aliasDefinition] of [
    ["bare_kill_group", "kill 0"],
    ["path_kill_signal_option", "/bin/kill -s TERM 0"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand("bye", "posix", marker);
    const result = spawnSync("bash", ["-c", `shopt -s expand_aliases; alias bye='${aliasDefinition}'; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      detached: true,
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper blocks existing shell functions with indirect self-kill", () => {
  for (const [name, functionBody] of [
    ["signal_option_group", "/bin/kill -s TERM 0"],
    ["long_signal_option_group", "/bin/kill --signal TERM 0"],
    ["equals_signal_option_group", "/bin/kill --signal=TERM 0"],
    ["signal_number_option_group", "/bin/kill -n 15 0"],
    ["variable_group", "p=0; kill -TERM \"$p\""],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand("bye", "posix", marker);
    const result = spawnSync("sh", ["-c", `bye(){ ${functionBody}; }; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      detached: true,
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper allows harmless existing functions and aliases", { skip: !HAS_BASH }, () => {
  for (const [name, setup, command, expected] of [
    ["function", "hello(){ printf FUNCTION_OK; };", "hello", "FUNCTION_OK"],
    ["alias", "shopt -s expand_aliases; alias ll='printf ALIAS_OK';", "ll", "ALIAS_OK"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("bash", ["-c", `${setup} ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, new RegExp(expected));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper keeps safe custom function state changes", { skip: !HAS_BASH }, () => {
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-safe-function-state-"));
  try {
    for (const [name, setup, command, probe, expected] of [
      ["export", "activate(){ export NETCATTY_FUNCTION_STATE=ok; }", "activate", "printf 'VALUE=%s\\n' \"$NETCATTY_FUNCTION_STATE\"", /VALUE=ok/],
      ["cd", `jump(){ cd '${dir.replace(/'/g, "'\\''")}'; }`, "jump", "pwd", new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ]) {
      const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
      const wrapped = buildWrappedCommand(command, "posix", marker);
      const result = spawnSync("bash", ["-c", `${setup}; ${wrapped}${probe}`], {
        encoding: "utf8",
        env: {
          ...process.env,
          SHELL: "/bin/false",
        },
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
      assert.match(result.stdout, new RegExp(`${marker}_E:0`));
      assert.match(result.stdout, expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper blocks redefined safe builtins before they can exit the parent", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp", "posix", marker);
  const result = spawnSync("sh", ["-c", `cd(){ exit 7; }; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates bash-only command prefixes that can exit", { skip: !HAS_BASH }, () => {
  for (const [name, command, code] of [
    ["builtin_set", "builtin set -e; false; echo SHOULD_NOT_PRINT", 1],
    ["ansi_exit", "$'exit' 7", 7],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("bash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:${code}`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
  }
});

test("posix wrapper isolates zsh setopt errexit", { skip: !HAS_ZSH }, () => {
  for (const [name, command] of [
    ["errexit", "setopt errexit; false; echo SHOULD_NOT_PRINT"],
    ["err_exit", "setopt err_exit; false; echo SHOULD_NOT_PRINT"],
    ["upper", "setopt ERR_EXIT; false; echo SHOULD_NOT_PRINT"],
    ["set_o", "set -o err_exit; false; echo SHOULD_NOT_PRINT"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:1`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
  }
});

test("posix wrapper isolates zsh emulate errexit", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp; emulate sh -o errexit; false; echo SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper handles zsh return and repeat without losing the marker", { skip: !HAS_ZSH }, () => {
  for (const [name, command, code] of [
    ["return", "cd /tmp; return 7", 7],
    ["repeat_exit", "cd /tmp; repeat 1 exit 12", 12],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:${code}`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper blocks zsh repeat self-kill", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp; repeat 1 kill -TERM $$", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper keeps safe zsh setopt state", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("setopt noclobber", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `${wrapped}setopt | grep -q '^noclobber$' && printf 'NOCLOBBER_ON\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /NOCLOBBER_ON/);
});

test("posix wrapper keeps safe zsh unsetopt state", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("unsetopt noclobber", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `setopt noclobber; ${wrapped}setopt | grep -q '^noclobber$' || printf 'NOCLOBBER_OFF\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /NOCLOBBER_OFF/);
});

test("posix wrapper keeps safe bash shopt state", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("shopt -s extglob", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}shopt -q extglob && printf 'EXTGLOB_ON\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /EXTGLOB_ON/);
});

test("posix wrapper keeps safe shell state builtins", { skip: !HAS_BASH }, () => {
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-state-builtins-"));
  try {
    for (const [name, command, probe, expected] of [
      ["umask", "umask 077", "umask", /077/],
      ["pushd", `pushd '${dir.replace(/'/g, "'\\''")}' >/dev/null`, "pwd", new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
      ["popd", `pushd '${dir.replace(/'/g, "'\\''")}' >/dev/null; popd >/dev/null`, "pwd", /^\/tmp$/m],
    ]) {
      const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
      const wrapped = buildWrappedCommand(command, "posix", marker);
      const result = spawnSync("bash", ["-c", `cd /tmp; ${wrapped}${probe}`], {
        encoding: "utf8",
        env: {
          ...process.env,
          SHELL: "/bin/false",
        },
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`${marker}_E:0`));
      assert.match(result.stdout, expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper blocks dangerous zsh debug trap functions", { skip: !HAS_ZSH }, () => {
  for (const [name, command] of [
    ["exit", "TRAPDEBUG(){ exit 17; }"],
    ["kill", "TRAPDEBUG(){ kill -TERM $$; }"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper clears its temporary INT trap in zsh", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf OK", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.doesNotMatch(result.stdout, /__NCMCP_int_seen/);
});

test("posix wrapper isolates exit behind zsh precommand modifiers", { skip: !HAS_ZSH }, () => {
  for (const [name, command] of [
    ["noglob", "cd /tmp; noglob exit 7"],
    ["nocorrect", "cd /tmp; nocorrect exit 7"],
    ["dash", "cd /tmp; - exit 7"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("zsh", ["-fc", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:7`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper blocks zsh autoload functions with unknown bodies", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-autoload-"));
  try {
    writeFileSync(join(dir, "bye"), "bye(){ kill -TERM $$; }\n");
    const wrapped = buildWrappedCommand("cd /tmp; bye", "posix", marker);
    const result = spawnSync("zsh", ["-fc", `fpath=('${dir.replace(/'/g, "'\\''")}' $fpath); autoload bye; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper keeps function definitions with exit in the parent shell", () => {
  for (const [name, command] of [
    ["brace", "bye(){ exit 7; }"],
    ["subshell", "bye() ( exit 7 )"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}type bye >/dev/null && printf 'FUNCTION_DEFINED\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /FUNCTION_DEFINED/);
  }
});

test("posix wrapper allows safe existing functions with return and child cleanup", { skip: !HAS_BASH }, () => {
  for (const [name, setup, command] of [
    ["return", "helper(){ return 0; }", "helper"],
    ["child_kill", "helper(){ sleep 1 & child_pid=$!; kill \"$child_pid\"; wait \"$child_pid\" 2>/dev/null; return 0; }", "helper"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("bash", ["-c", `${setup}; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper restores existing INT trap when the command leaves it alone", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf OK", "posix", marker);
  const result = spawnSync("sh", ["-c", `trap 'echo USER_INT' INT; ${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /USER_INT/);
});

test("posix wrapper allows clearing DEBUG and ERR traps", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("trap - DEBUG; trap - ERR", "posix", marker);
  const result = spawnSync("bash", ["-c", `trap 'echo DEBUG_TRAP' DEBUG; trap 'echo ERR_TRAP' ERR; ${wrapped}trap -p DEBUG ERR`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.doesNotMatch(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.doesNotMatch(result.stdout, /trap -- 'echo DEBUG_TRAP' DEBUG/);
  assert.doesNotMatch(result.stdout, /trap -- 'echo ERR_TRAP' ERR/);
});

test("posix wrapper isolates dash-unsupported trap query options", { skip: !HAS_DASH }, () => {
  for (const [name, command] of [
    ["trap_p_int", "trap -p INT"],
    ["trap_l", "trap -l"],
    ["trap_p_int_then_sleep", "trap -p INT; sleep 0"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("dash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_S`));
    assert.match(result.stdout, new RegExp(`${marker}_E:2`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper does not expose its temporary INT trap to trap queries", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("trap", "posix", marker);
  const result = spawnSync("sh", ["-c", wrapped], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.doesNotMatch(result.stdout, /__NCMCP_int_seen/);
});

test("posix wrapper keeps a user command's new INT trap", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("trap 'echo NEW_INT' INT", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /NEW_INT/);
});

test("posix wrapper keeps a user command's new INT trap in a compound command", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp; trap 'echo NEW_INT' INT", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /NEW_INT/);
});

test("posix wrapper keeps an allowed function's new INT trap", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp; setint", "posix", marker);
  const result = spawnSync("sh", ["-c", `setint(){ trap 'echo FUNCTION_INT' INT; }; ${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /FUNCTION_INT/);
});

test("posix wrapper keeps a same-command function's new INT trap", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("setint(){ trap 'echo FUNCTION_INT' INT; }; setint", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /FUNCTION_INT/);
});

test("posix wrapper detects dangerous functions when PATH cannot find grep", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp", "posix", marker);
  const result = spawnSync("bash", ["-c", `cd(){ exit 7; }; PATH=/tmp; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper detects dangerous functions when shell inspection names are redefined", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("bye", "posix", marker);
  const result = spawnSync("bash", ["-c", `type(){ :; }; alias(){ :; }; typeset(){ :; }; functions(){ :; }; printf(){ :; }; bye(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper avoids user-defined type while inspecting dangerous functions", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp", "posix", marker);
  const result = spawnSync("bash", ["-c", `type(){ kill -TERM 0; }; cd(){ exit 7; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper avoids user-defined trap for commands that do not need INT protection", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `trap(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper avoids user-defined trap for path commands", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("/bin/sleep 0", "posix", marker);
  const result = spawnSync("bash", ["-c", `trap(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper avoids user-defined eval for path commands", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("/bin/echo OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `eval(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper avoids user-defined cleanup helpers", { skip: !HAS_BASH }, () => {
  for (const [name, helper] of [
    ["unset", "unset"],
    ["exit", "exit"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand("printf OK", "posix", marker);
    const result = spawnSync("bash", ["-c", `${helper}(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /OK/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper avoids user-defined zsh eval and unset helpers", { skip: !HAS_ZSH }, () => {
  for (const [name, helper] of [
    ["eval", "eval"],
    ["unset", "unset"],
  ]) {
    const marker = `__NCMCP_TEST_ZSH_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand("/bin/echo OK", "posix", marker);
    const result = spawnSync("zsh", ["-fc", `${helper}(){ kill -TERM 0; }; ${wrapped}print -r PARENT_STILL_ALIVE`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /OK/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper emits markers when builtin is redefined", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `builtin(){ kill -TERM 0; }; ${wrapped}command printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK/);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper emits markers when command is redefined", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("/bin/echo OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `command(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK/);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper blocks when command and builtin are both redefined", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("/bin/echo SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("bash", ["-c", `command(){ kill -TERM 0; }; builtin(){ kill -TERM 0; }; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper avoids user-defined bracket and true helpers", { skip: !HAS_BASH }, () => {
  for (const [name, helper] of [
    ["bracket", "["],
    ["true", "true"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand("/bin/echo OK", "posix", marker);
    const result = spawnSync("bash", ["-c", `${helper}(){ kill -TERM 0; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /OK/);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  }
});

test("posix wrapper isolates commands that redefine cleanup helpers", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("command(){ printf USER_COMMAND; }; true", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}if declare -F __NCMCP_p >/dev/null || set | grep -q '^__NCMCP'; then printf 'LEAKED\\n'; else printf 'CLEAN\\n'; fi; builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /CLEAN/);
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /USER_COMMAND/);
  assert.doesNotMatch(result.stdout, /LEAKED/);
});

test("posix wrapper blocks user-defined zsh builtin before it can exit the parent", { skip: !HAS_ZSH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("/bin/echo SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("zsh", ["-fc", `builtin(){ kill -TERM 0; }; ${wrapped}print -r PARENT_STILL_ALIVE`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper blocks user-defined printf before it can exit the parent", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `printf(){ exit 7; }; ${wrapped}builtin printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper cleans up internal helper names", { skip: !HAS_BASH }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}if declare -F __NCMCP_p >/dev/null || set | grep -q '^__NCMCP'; then printf 'LEAKED\\n'; else printf 'CLEAN\\n'; fi`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /CLEAN/);
  assert.doesNotMatch(result.stdout, /LEAKED/);
});

test("posix wrapper clears its temporary INT trap after PATH changes", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("export PATH=/tmp", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.doesNotMatch(result.stdout, /__NCMCP_int_seen/);
});

test("posix wrapper keeps a user command's no-op INT trap", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("trap ':' INT", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}trap`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /trap -- ':' INT/);
});

test("posix wrapper preserves errexit semantics inside isolated parent-errexit commands", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("false; echo SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("sh", ["-c", `set -e; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper preserves parent-errexit semantics for state-prefixed compound commands", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("cd /tmp; false; echo SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("sh", ["-c", `set -e; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper preserves parent-errexit semantics for common failing commands", () => {
  for (const [name, command] of [
    ["grep", "cd /tmp; grep NETCATTY_NO_MATCH /dev/null; echo SHOULD_NOT_PRINT"],
    ["test", "cd /tmp; test -f /tmp/netcatty-definitely-missing; echo SHOULD_NOT_PRINT"],
    ["pipeline", "cd /tmp; printf x | grep y; echo SHOULD_NOT_PRINT"],
    ["node", "cd /tmp; node -e 'process.exit(1)'; echo SHOULD_NOT_PRINT"],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `set -e; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:1`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
  }
});

test("posix wrapper keeps successful compound state changes with parent errexit", () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-errexit-state-"));
  try {
    const wrapped = buildWrappedCommand(`cd '${dir.replace(/'/g, "'\\''")}'; export NETCATTY_ERREXIT_STATE=ok`, "posix", marker);
    const result = spawnSync("sh", ["-c", `set -e; ${wrapped}printf 'PWD=%s VALUE=%s\\n' "$PWD" "$NETCATTY_ERREXIT_STATE"`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, new RegExp(`PWD=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /VALUE=ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper does not treat set option words as arguments", () => {
  const errexitMarker = "__NCMCP_TEST_ERREXIT_ARG__";
  const errexitWrapped = buildWrappedCommand("echo set +e", "posix", errexitMarker);
  const errexitResult = spawnSync("sh", ["-c", `set -e; ${errexitWrapped}false; printf 'SHOULD_NOT_PRINT\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(errexitResult.error, undefined);
  assert.notEqual(errexitResult.status, 0);
  assert.match(errexitResult.stdout, new RegExp(`${errexitMarker}_E:0`));
  assert.doesNotMatch(errexitResult.stdout, /SHOULD_NOT_PRINT/);

  const nounsetMarker = "__NCMCP_TEST_NOUNSET_ARG__";
  const nounsetWrapped = buildWrappedCommand("printf 'set +u\\n'", "posix", nounsetMarker);
  const nounsetResult = spawnSync("sh", ["-c", `set -u; ${nounsetWrapped}printf '%s\\n' "$NETCATTY_STILL_MISSING"; printf 'SHOULD_NOT_PRINT\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(nounsetResult.error, undefined);
  assert.notEqual(nounsetResult.status, 0);
  assert.match(nounsetResult.stdout, new RegExp(`${nounsetMarker}_E:0`));
  assert.doesNotMatch(nounsetResult.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper keeps safe nounset parent state changes", () => {
  const homePattern = new RegExp(`PWD=${String(process.env.HOME || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} HOME=${String(process.env.HOME || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  for (const [name, command, probe, expected] of [
    ["substitution", "export NETCATTY_NOUNSET_SAFE=$(printf ok)", "printf 'VALUE=%s\\n' \"$NETCATTY_NOUNSET_SAFE\"", /VALUE=ok/],
    ["literal", "export NETCATTY_NOUNSET_LITERAL='$MISSING'", "printf 'VALUE=%s\\n' \"$NETCATTY_NOUNSET_LITERAL\"", /VALUE=\$MISSING/],
    ["safe_cd_expansion", "cd \"$HOME\"", "printf 'PWD=%s HOME=%s\\n' \"$PWD\" \"$HOME\"", homePattern],
    ["safe_export_expansion", "export NETCATTY_NOUNSET_HOME=\"$HOME\"", "printf 'VALUE=%s HOME=%s\\n' \"$NETCATTY_NOUNSET_HOME\" \"$HOME\"", /VALUE=.+ HOME=.+/],
    ["default_export_expansion", "export NETCATTY_DEFAULTED=${NETCATTY_MISSING:-ok}", "printf 'VALUE=%s\\n' \"$NETCATTY_DEFAULTED\"", /VALUE=ok/],
    ["default_cd_expansion", "cd ${NETCATTY_MISSING_DIR:-/tmp}", "printf 'PWD=%s\\n' \"$PWD\"", /PWD=\/tmp/],
    ["assign_default_expansion", "export NETCATTY_MEQ_VALUE=${NETCATTY_MEQ:=ok}", "printf 'VALUE=%s ASSIGNED=%s\\n' \"$NETCATTY_MEQ_VALUE\" \"$NETCATTY_MEQ\"", /VALUE=ok ASSIGNED=ok/],
    ["alternate_expansion_unset", "export NETCATTY_ALT_VALUE=${NETCATTY_ALT:+nope}", "printf 'VALUE=%s\\n' \"$NETCATTY_ALT_VALUE\"", /VALUE=/],
    ["alternate_expansion_set", "NETCATTY_ALT=yes; export NETCATTY_ALT_VALUE=${NETCATTY_ALT:+ok}", "printf 'VALUE=%s\\n' \"$NETCATTY_ALT_VALUE\"", /VALUE=ok/],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `set -u; ${wrapped}${probe}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, expected);
  }
});

test("posix wrapper keeps user-disabled errexit and nounset disabled", () => {
  for (const [name, setup, command, probe, expected] of [
    ["errexit", "set -e; ", "set +e", "false; printf 'ERREXIT_OFF\\n'", /ERREXIT_OFF/],
    ["nounset", "set -u; ", "set +u", "printf 'NOUNSET_OFF=%s\\n' \"$NETCATTY_STILL_MISSING\"", /NOUNSET_OFF=/],
  ]) {
    const marker = `__NCMCP_TEST_${name.toUpperCase()}__`;
    const wrapped = buildWrappedCommand(command, "posix", marker);
    const result = spawnSync("sh", ["-c", `${setup}${wrapped}${probe}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, expected);
  }
});

test("posix wrapper restores parent options when commands re-enable them", () => {
  const errexitMarker = "__NCMCP_TEST_ERREXIT_REENABLE__";
  const errexitWrapped = buildWrappedCommand("set +e; set -e", "posix", errexitMarker);
  const errexitResult = spawnSync("sh", ["-c", `set -e; ${errexitWrapped}false; printf 'SHOULD_NOT_PRINT\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(errexitResult.error, undefined);
  assert.notEqual(errexitResult.status, 0);
  assert.match(errexitResult.stdout, new RegExp(`${errexitMarker}_E:0`));
  assert.doesNotMatch(errexitResult.stdout, /SHOULD_NOT_PRINT/);

  const nounsetMarker = "__NCMCP_TEST_NOUNSET_REENABLE__";
  const nounsetWrapped = buildWrappedCommand("set +u; set -u", "posix", nounsetMarker);
  const nounsetResult = spawnSync("sh", ["-c", `set -u; ${nounsetWrapped}printf '%s\\n' "$NETCATTY_STILL_MISSING"; printf 'SHOULD_NOT_PRINT\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(nounsetResult.error, undefined);
  assert.notEqual(nounsetResult.status, 0);
  assert.match(nounsetResult.stdout, new RegExp(`${nounsetMarker}_E:0`));
  assert.doesNotMatch(nounsetResult.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper allows ordinary arguments containing its marker prefix", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("printf '%s\\n' __NCMCP_demo", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /__NCMCP_demo/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper blocks relative source after changing directory", () => {
  const marker = "__NCMCP_TEST__";
  const dir = mkdtempSync(join(tmpdir(), "netcatty-pty-relative-source-"));
  try {
    writeFileSync(join(dir, "profile"), "kill -TERM 0\n");
    const wrapped = buildWrappedCommand(`cd '${dir.replace(/'/g, "'\\''")}'; . profile`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/sh",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
    assert.match(result.stdout, new RegExp(`${marker}_E:126`));
    assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("posix wrapper blocks existing shell functions used later in a compound command", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("echo hi; bye", "posix", marker);
  const result = spawnSync("sh", ["-c", `bye(){ kill -TERM 0; }; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Blocked unsafe shell-terminating command/);
  assert.match(result.stdout, new RegExp(`${marker}_E:126`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("execViaChannel registers a pending-cancel marker before the SSH channel opens", () => {
  // Regression for the IPC-transit race surfaced by codex on #1101
  // problem 3: if `cancelPtyExecsForSession` runs while we're still
  // waiting on `sshClient.exec`'s callback, the cancel finds nothing in
  // `activePtyExecs` and the channel opens anyway. The fix registers a
  // pending marker synchronously so the cancel has something to act on.
  const track = new Map();
  let execCallback;
  const fakeClient = {
    exec(_command, callback) {
      // Capture but do not invoke yet — simulates the channel-open
      // delay where the race window lives.
      execCallback = callback;
    },
  };
  void execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-1",
    timeoutMs: 5_000,
  });
  assert.equal(track.size, 1, "pending marker should be registered before the channel opens");
  const entry = Array.from(track.values())[0];
  assert.equal(entry.chatSessionId, "chat-1");
  assert.equal(typeof entry.cancel, "function");
  // Drain the callback so the timeout the test set doesn't fire later.
  execCallback(new Error("test teardown"), null);
});

test("execViaChannel drops the pending marker and resolves cleanly when sshClient.exec throws synchronously", async () => {
  const track = new Map();
  const fakeClient = {
    exec() {
      throw new Error("client destroyed");
    },
  };
  const result = await execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-throw",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "client destroyed");
  assert.equal(track.size, 0, "pending marker must be removed even on sync throw");
});

test("execViaChannel short-circuits when cancel fires before the SSH channel opens", async () => {
  const track = new Map();
  let execCallback;
  const fakeClient = {
    exec(_command, callback) {
      execCallback = callback;
    },
  };
  const resultPromise = execViaChannel(fakeClient, "sleep 5", {
    trackForCancellation: track,
    chatSessionId: "chat-2",
    timeoutMs: 5_000,
  });

  // Cancel while still waiting for the channel-open callback.
  assert.equal(track.size, 1);
  for (const entry of track.values()) {
    if (entry.chatSessionId === "chat-2") entry.cancel();
  }

  // Now the channel "opens" — even though `sshClient.exec` would
  // hand us a working stream, we must short-circuit because the user
  // already cancelled.
  const fakeExecStream = {
    closed: false,
    close() { this.closed = true; },
    stderr: { on() {} },
    on() {},
  };
  execCallback(null, fakeExecStream);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(fakeExecStream.closed, true, "should close the now-unwanted stream");
  assert.equal(track.size, 0, "pending marker should be removed after callback runs");
});
