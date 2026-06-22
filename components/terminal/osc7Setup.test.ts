import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { OSC7_MARKER, buildOsc7SetupCommand, shouldOfferOsc7SetupAction } from "./osc7Setup";

const runSetup = (env: NodeJS.ProcessEnv) => {
  execFileSync("/bin/sh", ["-c", buildOsc7SetupCommand()], {
    env: { ...process.env, ...env },
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

test("shouldOfferOsc7SetupAction only allows remote shell-style sessions", () => {
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "ssh" }), true);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "mosh" }), true);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "et" }), true);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "telnet" }), false);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "ssh", isNetworkDevice: true }), false);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "local", isLocalConnection: true }), false);
  assert.equal(shouldOfferOsc7SetupAction({ protocol: "serial", isSerialConnection: true }), false);
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

test("buildOsc7SetupCommand honors zsh ZDOTDIR captured from the current shell", () => {
  withTempHome("netcatty-osc7-zsh-", (home) => {
    const zdotdir = join(home, ".config", "zsh");
    runSetup({ HOME: home, SHELL: "/bin/zsh", ZDOTDIR: zdotdir });
    runSetup({ HOME: home, SHELL: "/bin/zsh", ZDOTDIR: zdotdir });

    const zshrcPath = join(zdotdir, ".zshrc");
    const zshrc = readFileSync(zshrcPath, "utf8");
    assert.equal(markerCount(zshrc), 2);
    assert.match(zshrc, /precmd_functions/);
    assert.equal(existsSync(join(home, ".zshrc")), false);
  });
});

test("buildOsc7SetupCommand configures fish once with valid fish syntax", () => {
  withTempHome("netcatty-osc7-fish-", (home) => {
    runSetup({ HOME: home, SHELL: "/usr/bin/fish" });
    runSetup({ HOME: home, SHELL: "/usr/bin/fish" });

    const fishConfigPath = join(home, ".config", "fish", "config.fish");
    const fishConfig = readFileSync(fishConfigPath, "utf8");
    assert.equal(markerCount(fishConfig), 2);
    assert.match(fishConfig, /fish_prompt/);

    if (existsSync("/opt/homebrew/bin/fish") || existsSync("/usr/bin/fish")) {
      execFileSync("fish", ["-n", fishConfigPath], { stdio: "pipe" });
    }
  });
});

test("buildOsc7SetupCommand can be pasted into supported shells", () => {
  const shells = existingShells(["/bin/bash", "/bin/zsh", "/opt/homebrew/bin/fish", "/usr/bin/fish"]);

  for (const shellPath of shells) {
    withTempHome(`netcatty-osc7-${basename(shellPath)}-`, (home) => {
      const zdotdir = join(home, "zdot");
      const xdgConfigHome = join(home, "xdg");

      execFileSync(shellPath, ["-c", buildOsc7SetupCommand()], {
        env: {
          ...process.env,
          HOME: home,
          SHELL: shellPath,
          ZDOTDIR: zdotdir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        stdio: "pipe",
      });

      const shellName = basename(shellPath);
      const configPath = shellName === "bash"
        ? join(home, ".bashrc")
        : shellName === "zsh"
          ? join(zdotdir, ".zshrc")
          : join(xdgConfigHome, "fish", "config.fish");

      const config = readFileSync(configPath, "utf8");
      assert.equal(markerCount(config), 2, shellPath);
    });
  }
});
