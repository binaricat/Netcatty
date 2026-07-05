import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  OSC7_MARKER,
  OSC7_SETUP_OTHER_USER_MARKER,
  OSC7_SETUP_STAGED_MARKER,
  buildOsc7ReloadCommand,
  buildOsc7SetupCommand,
  buildOsc7SetupExecCommand,
  buildOsc7StageScriptCommand,
  buildOsc7TypedSetupCommand,
  getOsc7StagedScriptSha256,
  parseOsc7SetupStagedPath,
  runOsc7SetupAction,
  shouldOfferOsc7SetupAction,
} from "./osc7Setup";

const runSetup = (env: NodeJS.ProcessEnv) => {
  execFileSync("/bin/sh", ["-c", buildOsc7SetupCommand()], {
    env: { ...process.env, ZDOTDIR: "", XDG_CONFIG_HOME: "", ...env },
    stdio: "pipe",
  });
};

const withTempHome = (prefix: string, fn: (home: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const markerCount = (content: string) => content.split(OSC7_MARKER).length - 1;

const existingShells = (paths: string[]) => Array.from(new Set(paths.filter(existsSync)));

const supportedShells = () => existingShells(["/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/fish", "/usr/bin/fish"]);

const quoteShellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const extractOsc7Path = (output: string) => {
  const escape = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  const payloadStart = output.indexOf(`${escape}]7;`);
  assert.notEqual(payloadStart, -1, "expected OSC 7 output");

  const payload = output.slice(payloadStart + `${escape}]7;`.length);
  const terminators = [payload.indexOf(escape), payload.indexOf(bell)].filter((index) => index >= 0);
  const payloadEnd = terminators.length > 0 ? Math.min(...terminators) : payload.length;
  const fileUrl = payload.slice(0, payloadEnd);
  assert.ok(fileUrl.startsWith("file://"), "expected OSC 7 file URL");

  return decodeURIComponent(new URL(fileUrl).pathname);
};

const runInteractiveHistoryProbe = ({
  shellPath,
  shellArgs,
  dumpHistoryCommand,
  dumpPath,
  env,
  input = buildOsc7SetupCommand(),
}: {
  shellPath: string;
  shellArgs: string[];
  dumpHistoryCommand: string;
  dumpPath: string;
  env: NodeJS.ProcessEnv;
  input?: string;
}) => {
  const result = spawnSync(shellPath, shellArgs, {
    env: { ...process.env, ZDOTDIR: "", XDG_CONFIG_HOME: "", ...env },
    input: `${input.replace(/\r/g, "\n")}\n${dumpHistoryCommand}\nexit\n`,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(existsSync(dumpPath), result.stderr || result.stdout);
  return readFileSync(dumpPath, "utf8");
};

test("shouldOfferOsc7SetupAction only allows remote shell-style sessions", () => {
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "ssh" }), true);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "mosh" }), true);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "et" }), true);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "telnet" }), false);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "ssh", isNetworkDevice: true }), false);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "local", isLocalConnection: true }), false);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "serial", isSerialConnection: true }), false);
});

test("runOsc7SetupAction configures in the background and only sends a small reload command", async () => {
  const writes: Array<{ sessionId: string; data: string; automated?: boolean }> = [];
  const localData: string[] = [];
  let setupArgs: { sessionId: string; command: string } | null = null;

  const result = await runOsc7SetupAction({
    status: "connected",
    sessionId: "session-1",
    setupCommand: "printf setup-script",
    setupOsc7Tracking: async (sessionId, command) => {
      setupArgs = { sessionId, command };
      return {
        success: true,
        stdout: "__NETCATTY_OSC7_SETUP_SHELL__=bash\n__NETCATTY_OSC7_SETUP_CONFIG__=/home/me/.bashrc\n\u001b]7;file://host/home/me\u0007",
        stderr: "",
        code: 0,
      };
    },
    writeToSession: (sessionId, data, options) => {
      writes.push({ sessionId, data, automated: options?.automated });
    },
    writeLocalTerminalData: (data) => {
      localData.push(data);
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(setupArgs, { sessionId: "session-1", command: "printf setup-script" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, "session-1");
  assert.equal(writes[0].automated, true);
  assert.match(writes[0].data, /source '\/home\/me\/\.bashrc'/);
  assert.doesNotMatch(writes[0].data, /setup-script/);
  assert.deepEqual(localData, ["\u001b]7;file://host/home/me\u0007"]);
});

test("runOsc7SetupAction stages the script and types a short runner for user-switched shells", async () => {
  const writes: Array<{ sessionId: string; data: string; automated?: boolean }> = [];
  const localData: string[] = [];
  const setupCommands: string[] = [];

  const result = await runOsc7SetupAction({
    status: "connected",
    sessionId: "session-1",
    setupCommand: "printf setup-script",
    setupOsc7Tracking: async (_sessionId, command) => {
      setupCommands.push(command);
      if (setupCommands.length === 1) {
        return {
          success: false,
          stdout: `${OSC7_SETUP_OTHER_USER_MARKER}bash\n`,
          stderr: "Netcatty OSC 7 setup: the active terminal shell belongs to another user\n",
          code: 5,
          error: "Netcatty OSC 7 setup: the active terminal shell belongs to another user",
        };
      }
      return {
        success: true,
        stdout: `${OSC7_SETUP_STAGED_MARKER}/tmp/.netcatty-osc7-setup.abc123\n`,
        stderr: "",
        code: 0,
      };
    },
    writeToSession: (sessionId, data, options) => {
      writes.push({ sessionId, data, automated: options?.automated });
    },
    writeLocalTerminalData: (data) => {
      localData.push(data);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.sentToTerminal, true);
  assert.equal(setupCommands.length, 2);
  assert.match(setupCommands[1], /mktemp/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, "session-1");
  assert.equal(writes[0].automated, true);
  assert.match(writes[0].data, /NETCATTY_OSC7_FORCE_SHELL=bash/);
  assert.match(writes[0].data, /'\/tmp\/\.netcatty-osc7-setup\.abc123'/);
  assert.match(writes[0].data, /\.bashrc/);
  // Single line: one history entry, so the appended bash cleanup deletes it.
  assert.doesNotMatch(writes[0].data.slice(0, -1), /[\r\n]/);
  assert.deepEqual(localData, []);
});

test("runOsc7SetupAction fails when the setup script cannot be staged", async () => {
  const writes: string[] = [];
  let calls = 0;

  const result = await runOsc7SetupAction({
    status: "connected",
    sessionId: "session-1",
    setupCommand: "printf setup-script",
    setupOsc7Tracking: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          success: false,
          stdout: `${OSC7_SETUP_OTHER_USER_MARKER}bash\n`,
          stderr: "",
          code: 5,
        };
      }
      return { success: false, stdout: "", stderr: "mktemp: failed", code: 1 };
    },
    writeToSession: (_sessionId, data) => {
      writes.push(data);
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error || "", /mktemp: failed|setup failed/);
  assert.deepEqual(writes, []);
});

test("runOsc7SetupAction reports unsupported user-switched shells instead of typing", async () => {
  const writes: string[] = [];

  const result = await runOsc7SetupAction({
    status: "connected",
    sessionId: "session-1",
    setupCommand: "printf setup-script",
    setupOsc7Tracking: async () => ({
      success: false,
      stdout: `${OSC7_SETUP_OTHER_USER_MARKER}dash\n`,
      stderr: "",
      code: 5,
    }),
    writeToSession: (_sessionId, data) => {
      writes.push(data);
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error || "", /does not support/);
  assert.deepEqual(writes, []);
});

test("runOsc7SetupAction fails without reload metadata instead of reporting a partial setup", async () => {
  const writes: string[] = [];
  const localData: string[] = [];

  const result = await runOsc7SetupAction({
    status: "connected",
    sessionId: "session-1",
    setupCommand: "printf setup-script",
    setupOsc7Tracking: async () => ({
      success: true,
      stdout: "\u001b]7;file://host/home/me\u0007",
      stderr: "",
      code: 0,
    }),
    writeToSession: (_sessionId, data) => {
      writes.push(data);
    },
    writeLocalTerminalData: (data) => {
      localData.push(data);
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error || "", /reload metadata/);
  assert.deepEqual(writes, []);
  assert.deepEqual(localData, []);
});

test("buildOsc7SetupCommand configures bash once and prompt loading stays idempotent", () => {
  withTempHome("netcatty-osc7-bash-", (home) => {
    runSetup({ HOME: home, SHELL: "/bin/bash" });
    runSetup({ HOME: home, SHELL: "/bin/bash" });

    const bashrcPath = join(home, ".bashrc");
    const bashrc = readFileSync(bashrcPath, "utf8");
    assert.equal(markerCount(bashrc), 2);
    assert.match(bashrc, /PROMPT_COMMAND/);

    const output = execFileSync(
      "/bin/bash",
      [
        "-lc",
        `PROMPT_COMMAND=existing; source ${JSON.stringify(bashrcPath)}; source ${JSON.stringify(bashrcPath)}; printf '%s' "$PROMPT_COMMAND"`,
      ],
      { env: { ...process.env, HOME: home } },
    ).toString("utf8");

    assert.equal(output.split("osc7_cwd").length - 1, 1);
  });
});

test("buildOsc7SetupCommand preserves setup failure status", () => {
  withTempHome("netcatty-osc7-unsupported-shell-", (home) => {
    const result = spawnSync("/bin/sh", ["-c", buildOsc7SetupCommand()], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: "/bin/unknown",
        ZDOTDIR: "",
        XDG_CONFIG_HOME: "",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /unsupported shell unknown/);
  });
});

test("buildOsc7SetupExecCommand configures bash through a background exec shell", () => {
  withTempHome("netcatty-osc7-exec-bash-", (home) => {
    const output = execFileSync("/bin/sh", ["-c", buildOsc7SetupExecCommand()], {
      env: { ...process.env, HOME: home, SHELL: "/bin/bash" },
      stdio: "pipe",
    }).toString("utf8");

    assert.match(output, /__NETCATTY_OSC7_SETUP_SHELL__=bash/);
    assert.match(output, new RegExp(`__NETCATTY_OSC7_SETUP_CONFIG__=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.bashrc`));
    const bashrc = readFileSync(join(home, ".bashrc"), "utf8");
    assert.equal(markerCount(bashrc), 2);
  });
});

const withStagedSetupScript = (fn: (scriptPath: string) => void) => {
  const output = execFileSync("/bin/sh", ["-c", buildOsc7StageScriptCommand()], {
    stdio: "pipe",
  }).toString("utf8");
  const scriptPath = parseOsc7SetupStagedPath(output);
  assert.ok(scriptPath, "expected staged script path");
  try {
    fn(scriptPath);
  } finally {
    rmSync(scriptPath, { force: true });
  }
};

test("buildOsc7TypedSetupCommand stays a single line for reliable history cleanup", async () => {
  const sha256 = await getOsc7StagedScriptSha256();
  for (const shell of ["bash", "zsh", "fish"] as const) {
    const command = buildOsc7TypedSetupCommand(shell, "/tmp/.netcatty-osc7-setup.abc123", sha256);
    assert.ok(command.endsWith("\r"), shell);
    assert.doesNotMatch(command.slice(0, -1), /[\r\n]/, shell);
  }
});

test("buildOsc7TypedSetupCommand configures bash and removes the staged script", async () => {
  const sha256 = await getOsc7StagedScriptSha256();
  withTempHome("netcatty-osc7-typed-bash-", (home) => {
    withStagedSetupScript((scriptPath) => {
      const command = buildOsc7TypedSetupCommand("bash", scriptPath, sha256).replace(/\r/g, "\n");
      const output = execFileSync("/bin/bash", ["-c", command], {
        env: { ...process.env, HOME: home, SHELL: "/bin/bash", ZDOTDIR: "", XDG_CONFIG_HOME: "" },
        stdio: "pipe",
      }).toString("utf8");

      const bashrc = readFileSync(join(home, ".bashrc"), "utf8");
      assert.equal(markerCount(bashrc), 2);
      assert.match(bashrc, /PROMPT_COMMAND/);
      assert.doesNotMatch(output, /__NETCATTY_OSC7_SETUP_SHELL__|__NETCATTY_OSC7_SETUP_CONFIG__/);
      assert.ok(output.includes("\u001b]7;file://"), "expected OSC 7 output");
      assert.equal(existsSync(scriptPath), false, "staged script should be removed");
    });
  });
});

test("buildOsc7TypedSetupCommand refuses to run a tampered staged script", async () => {
  const sha256 = await getOsc7StagedScriptSha256();
  withTempHome("netcatty-osc7-typed-tampered-", (home) => {
    withStagedSetupScript((scriptPath) => {
      writeFileSync(scriptPath, `echo pwned > "$HOME/pwned"\n`);
      const command = buildOsc7TypedSetupCommand("bash", scriptPath, sha256).replace(/\r/g, "\n");
      const result = spawnSync("/bin/bash", ["-c", command], {
        env: { ...process.env, HOME: home, SHELL: "/bin/bash", ZDOTDIR: "", XDG_CONFIG_HOME: "" },
        encoding: "utf8",
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /verification failed/);
      assert.equal(existsSync(join(home, "pwned")), false, "tampered script must not run");
      assert.equal(existsSync(join(home, ".bashrc")), false);
      assert.equal(existsSync(scriptPath), false, "staged script should be removed before verification");
    });
  });
});

test("buildOsc7TypedSetupCommand does not leave the typed runner in bash history", async () => {
  const sha256 = await getOsc7StagedScriptSha256();
  withTempHome("netcatty-osc7-typed-history-bash-", (home) => {
    withStagedSetupScript((scriptPath) => {
      const dumpPath = join(home, "bash-history-dump");
      const output = runInteractiveHistoryProbe({
        shellPath: "/bin/bash",
        shellArgs: ["--noprofile", "--norc", "-i"],
        dumpHistoryCommand: `history > ${quoteShellArg(dumpPath)}`,
        dumpPath,
        env: {
          HOME: home,
          HISTFILE: join(home, ".bash_history"),
          SHELL: "/bin/bash",
        },
        input: `echo keepme\n${buildOsc7TypedSetupCommand("bash", scriptPath, sha256)}`,
      });

      assert.match(output, /echo keepme/);
      assert.doesNotMatch(output, /NETCATTY_OSC7_FORCE_SHELL|__netcatty_osc7|history -d/);
    });
  });
});

test("buildOsc7TypedSetupCommand stays idempotent for bash", async () => {
  const sha256 = await getOsc7StagedScriptSha256();
  withTempHome("netcatty-osc7-typed-bash-idempotent-", (home) => {
    const env = { ...process.env, HOME: home, SHELL: "/bin/bash", ZDOTDIR: "", XDG_CONFIG_HOME: "" };
    for (let run = 0; run < 2; run += 1) {
      withStagedSetupScript((scriptPath) => {
        const command = buildOsc7TypedSetupCommand("bash", scriptPath, sha256).replace(/\r/g, "\n");
        execFileSync("/bin/bash", ["-c", command], { env, stdio: "pipe" });
      });
    }

    assert.equal(markerCount(readFileSync(join(home, ".bashrc"), "utf8")), 2);
  });
});

test("buildOsc7TypedSetupCommand honors shell-local unexported zsh ZDOTDIR", async (t) => {
  const zshPath = existingShells(["/bin/zsh", "/usr/bin/zsh"])[0];
  if (!zshPath) {
    t.skip("zsh is not installed on this runner");
    return;
  }

  const sha256 = await getOsc7StagedScriptSha256();
  withTempHome("netcatty-osc7-typed-zsh-", (home) => {
    const zdotdir = join(home, ".config", "zsh");
    withStagedSetupScript((scriptPath) => {
      const command = buildOsc7TypedSetupCommand("zsh", scriptPath, sha256).replace(/\r/g, "\n");
      // ZDOTDIR is a shell-local (unexported) parameter, like a user setting
      // it in .zshenv without export; the typed wrapper must forward it.
      const output = execFileSync(zshPath, ["-c", `ZDOTDIR=${JSON.stringify(zdotdir)}; ${command}`], {
        env: { ...process.env, HOME: home, SHELL: zshPath, ZDOTDIR: undefined, XDG_CONFIG_HOME: "" },
        stdio: "pipe",
      }).toString("utf8");

      const zshrc = readFileSync(join(zdotdir, ".zshrc"), "utf8");
      assert.equal(markerCount(zshrc), 2);
      assert.match(zshrc, /precmd_functions/);
      assert.equal(existsSync(join(home, ".zshrc")), false);
      assert.ok(output.includes("\u001b]7;file://"), "expected OSC 7 output");
    });
  });
});

test("buildOsc7TypedSetupCommand configures fish through its typed fallback", async (t) => {
  const fishPath = existingShells(["/opt/homebrew/bin/fish", "/usr/bin/fish"])[0];
  if (!fishPath) {
    t.skip("fish is not installed on this runner");
    return;
  }

  const sha256 = await getOsc7StagedScriptSha256();
  withTempHome("netcatty-osc7-typed-fish-", (home) => {
    withStagedSetupScript((scriptPath) => {
      const command = buildOsc7TypedSetupCommand("fish", scriptPath, sha256).replace(/\r/g, "\n");
      const output = execFileSync(fishPath, ["-c", command], {
        env: { ...process.env, HOME: home, SHELL: fishPath, ZDOTDIR: "", XDG_CONFIG_HOME: "" },
        stdio: "pipe",
      }).toString("utf8");

      const fishConfig = readFileSync(join(home, ".config", "fish", "config.fish"), "utf8");
      assert.equal(markerCount(fishConfig), 2);
      assert.match(fishConfig, /fish_prompt/);
      assert.ok(output.includes("\u001b]7;file://"), "expected OSC 7 output");
    });
  });
});

test("buildOsc7SetupExecCommand carries the expected cwd for current-tab matching", () => {
  const command = buildOsc7SetupExecCommand("/srv/app's cwd");

  assert.match(command, /NETCATTY_OSC7_EXPECTED_CWD='\/srv\/app'\\''s cwd'/);
});

test("buildOsc7SetupExecCommand honors exported zsh ZDOTDIR fallback", (t) => {
  const zshPath = existingShells(["/bin/zsh", "/usr/bin/zsh"])[0];
  if (!zshPath) {
    t.skip("zsh is not installed on this runner");
    return;
  }

  withTempHome("netcatty-osc7-exec-zsh-", (home) => {
    const zdotdir = join(home, ".config", "zsh");
    const output = execFileSync("/bin/sh", ["-c", buildOsc7SetupExecCommand()], {
      env: { ...process.env, HOME: home, SHELL: zshPath, ZDOTDIR: zdotdir },
      stdio: "pipe",
    }).toString("utf8");

    const zshrcPath = join(zdotdir, ".zshrc");
    assert.match(output, /__NETCATTY_OSC7_SETUP_SHELL__=zsh/);
    assert.match(output, new RegExp(`__NETCATTY_OSC7_SETUP_CONFIG__=${zshrcPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(markerCount(readFileSync(zshrcPath, "utf8")), 2);
  });
});

test("buildOsc7SetupCommand honors zsh ZDOTDIR captured from the current shell", (t) => {
  const zshPath = existingShells(["/bin/zsh", "/usr/bin/zsh"])[0];
  if (!zshPath) {
    t.skip("zsh is not installed on this runner");
    return;
  }

  withTempHome("netcatty-osc7-zsh-", (home) => {
    const zdotdir = join(home, ".config", "zsh");
    runSetup({ HOME: home, SHELL: zshPath, ZDOTDIR: zdotdir });
    runSetup({ HOME: home, SHELL: zshPath, ZDOTDIR: zdotdir });

    const zshrcPath = join(zdotdir, ".zshrc");
    const zshrc = readFileSync(zshrcPath, "utf8");
    assert.equal(markerCount(zshrc), 2);
    assert.match(zshrc, /precmd_functions/);
    assert.equal(existsSync(join(home, ".zshrc")), false);

    execFileSync(zshPath, ["-uc", `source ${JSON.stringify(zshrcPath)}; print -r -- "\${precmd_functions[*]}"`], {
      env: { ...process.env, HOME: home, ZDOTDIR: zdotdir },
      stdio: "pipe",
    });
  });
});

test("buildOsc7SetupCommand configures fish once with valid fish syntax", () => {
  withTempHome("netcatty-osc7-fish-", (home) => {
    const fishPath = existingShells(["/opt/homebrew/bin/fish", "/usr/bin/fish"])[0] ?? "/usr/bin/fish";
    runSetup({ HOME: home, SHELL: fishPath });
    runSetup({ HOME: home, SHELL: fishPath });

    const fishConfigPath = join(home, ".config", "fish", "config.fish");
    const fishConfig = readFileSync(fishConfigPath, "utf8");
    assert.equal(markerCount(fishConfig), 2);
    assert.match(fishConfig, /fish_prompt/);

    if (existsSync(fishPath)) {
      execFileSync(fishPath, ["-n", fishConfigPath], { stdio: "pipe" });
      execFileSync(fishPath, ["-c", `source ${JSON.stringify(fishConfigPath)}; functions -q __netcatty_osc7_cwd`], {
        env: { ...process.env, HOME: home },
        stdio: "pipe",
      });
    }
  });
});

test("buildOsc7SetupCommand can be pasted into supported shells", () => {
  const shells = supportedShells();

  if (process.env.CI) {
    assert.ok(shells.some((shellPath) => basename(shellPath) === "fish"), "CI must exercise fish");
  }

  for (const shellPath of shells) {
    withTempHome(`netcatty-osc7-${basename(shellPath)}-`, (home) => {
      const zdotdir = join(home, "zdot");
      const xdgConfigHome = join(home, "xdg");
      const specialCwd = join(home, "space dir#frag?query%pct");
      mkdirSync(specialCwd, { recursive: true });

      const output = execFileSync(shellPath, ["-c", buildOsc7SetupCommand()], {
        cwd: specialCwd,
        env: {
          ...process.env,
          HOME: home,
          SHELL: shellPath,
          ZDOTDIR: zdotdir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        stdio: "pipe",
      }).toString("utf8");

      const shellName = basename(shellPath);
      const configPath = shellName === "bash"
        ? join(home, ".bashrc")
        : shellName === "zsh"
          ? join(zdotdir, ".zshrc")
          : join(xdgConfigHome, "fish", "config.fish");

      const config = readFileSync(configPath, "utf8");
      assert.equal(markerCount(config), 2, shellPath);
      assert.equal(realpathSync(extractOsc7Path(output)), realpathSync(specialCwd), shellPath);
    });
  }
});

test("buildOsc7ReloadCommand does not leave reload command in bash history", () => {
  withTempHome("netcatty-osc7-reload-history-bash-", (home) => {
    const bashrcPath = join(home, ".bashrc");
    const dumpPath = join(home, "bash-history-dump");
    mkdirSync(home, { recursive: true });
    writeFileSync(bashrcPath, "osc7_cwd(){ :; }\n");
    const reloadCommand = buildOsc7ReloadCommand({ shell: "bash", configPath: bashrcPath });

    assert.ok(reloadCommand);
    assert.doesNotMatch(reloadCommand.slice(0, -1), /[\r\n]/);

    const output = runInteractiveHistoryProbe({
      shellPath: "/bin/bash",
      shellArgs: ["--noprofile", "--norc", "-i"],
      dumpHistoryCommand: `history > ${quoteShellArg(dumpPath)}`,
      dumpPath,
      env: {
        HOME: home,
        HISTFILE: join(home, ".bash_history"),
        HISTCONTROL: "ignoreboth",
        SHELL: "/bin/bash",
      },
      input: `echo keepme\n${reloadCommand}`,
    });

    assert.match(output, /echo keepme/);
    assert.doesNotMatch(output, /osc7_cwd|source .*\.bashrc|__netcatty_osc7|history -d/);
  });
});

test("buildOsc7ReloadCommand preserves bash nounset", () => {
  withTempHome("netcatty-osc7-reload-nounset-bash-", (home) => {
    const bashrcPath = join(home, ".bashrc");
    const optionDumpPath = join(home, "bash-options-dump");
    mkdirSync(home, { recursive: true });
    writeFileSync(bashrcPath, "osc7_cwd(){ :; }\n");

    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-i"], {
      env: {
        ...process.env,
        HOME: home,
        HISTFILE: join(home, ".bash_history"),
        SHELL: "/bin/bash",
      },
      input: [
        "set -u",
        (buildOsc7ReloadCommand({ shell: "bash", configPath: bashrcPath }) ?? "").replace(/\r/g, "\n"),
        `set -o | grep nounset > ${quoteShellArg(optionDumpPath)}`,
        "exit",
      ].join("\n"),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(optionDumpPath, "utf8"), /\bon\b/);
  });
});

test("buildOsc7ReloadCommand does not delete bash history when reload is not recorded", () => {
  withTempHome("netcatty-osc7-reload-ignored-history-bash-", (home) => {
    const bashrcPath = join(home, ".bashrc");
    const dumpPath = join(home, "bash-history-dump");
    mkdirSync(home, { recursive: true });
    writeFileSync(bashrcPath, "osc7_cwd(){ :; }\n");

    const output = runInteractiveHistoryProbe({
      shellPath: "/bin/bash",
      shellArgs: ["--noprofile", "--norc", "-i"],
      dumpHistoryCommand: `history > ${quoteShellArg(dumpPath)}`,
      dumpPath,
      env: {
        HOME: home,
        HISTFILE: join(home, ".bash_history"),
        HISTIGNORE: "*__netcatty_osc7_history_cleanup_marker__=1*",
        SHELL: "/bin/bash",
      },
      input: `echo keepme\n${buildOsc7ReloadCommand({ shell: "bash", configPath: bashrcPath }) ?? ""}`,
    });

    assert.match(output, /echo keepme/);
    assert.doesNotMatch(output, /osc7_cwd|source .*\.bashrc|__netcatty_osc7|history -d/);
  });
});

test("buildOsc7ReloadCommand bypasses custom bash history wrappers", () => {
  withTempHome("netcatty-osc7-reload-wrapped-history-bash-", (home) => {
    const bashrcPath = join(home, ".bashrc");
    const dumpPath = join(home, "bash-history-dump");
    mkdirSync(home, { recursive: true });
    writeFileSync(bashrcPath, "osc7_cwd(){ :; }\n");

    const output = runInteractiveHistoryProbe({
      shellPath: "/bin/bash",
      shellArgs: ["--noprofile", "--norc", "-i"],
      dumpHistoryCommand: `builtin history > ${quoteShellArg(dumpPath)}`,
      dumpPath,
      env: {
        HOME: home,
        HISTFILE: join(home, ".bash_history"),
        SHELL: "/bin/bash",
      },
      input: [
        'history(){ echo custom; }',
        "echo keepme",
        buildOsc7ReloadCommand({ shell: "bash", configPath: bashrcPath }) ?? "",
      ].join("\n"),
    });

    assert.match(output, /echo keepme/);
    assert.doesNotMatch(output, /osc7_cwd|source .*\.bashrc|__netcatty_osc7|history -d/);
  });
});

test("buildOsc7SetupCommand runs under strict unset-variable mode", () => {
  for (const shellPath of existingShells(["/bin/bash", "/bin/zsh"])) {
    withTempHome(`netcatty-osc7-strict-${basename(shellPath)}-`, (home) => {
      execFileSync(shellPath, ["-uc", buildOsc7SetupCommand()], {
        env: {
          ...process.env,
          HOME: home,
          SHELL: shellPath,
          ZDOTDIR: undefined,
          XDG_CONFIG_HOME: undefined,
        },
        stdio: "pipe",
      });
    });
  }
});
