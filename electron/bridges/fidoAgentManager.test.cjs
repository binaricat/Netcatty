"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAgentStdout,
  isAgentLive,
  releaseFidoAgent,
  getActiveFidoAgentSocket,
  shutdownFidoAgentSubsystem,
  acquireFidoAgent,
  getTempBase,
} = require("./fidoAgentManager.cjs");

test("parseAgentStdout extracts sock and pid", () => {
  const parsed = parseAgentStdout(
    "SSH_AUTH_SOCK=/tmp/agent.123; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=9999; export SSH_AGENT_PID;\n",
  );
  assert.equal(parsed.socketPath, "/tmp/agent.123");
  assert.equal(parsed.agentPid, 9999);
});

test("getTempBase uses Netcatty managed temp dir (no os.tmpdir fallback)", () => {
  const tempDirBridge = require("./tempDirBridge.cjs");
  const managed = tempDirBridge.getTempDir();
  assert.equal(getTempBase(), managed);
  assert.match(managed, /Netcatty/i);
});

test("release without acquire is safe", () => {
  releaseFidoAgent();
  releaseFidoAgent();
  assert.equal(getActiveFidoAgentSocket(), null);
  assert.equal(isAgentLive(), false);
  shutdownFidoAgentSubsystem();
});

async function withManagedTemp(run) {
  const fs = require("node:fs");
  const path = require("node:path");
  const tempDirBridge = require("./tempDirBridge.cjs");
  const managedTemp = fs.mkdtempSync(path.join(__dirname, "netcatty-fido-win-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  tempDirBridge.getTempDir = () => managedTemp;
  try {
    return await run(managedTemp);
  } finally {
    tempDirBridge.getTempDir = originalGetTempDir;
    shutdownFidoAgentSubsystem();
    fs.rmSync(managedTemp, { recursive: true, force: true });
  }
}

test("acquireFidoAgent on win32 starts a prompt-capable child agent when -a works", async () => {
  await withManagedTemp(async () => {
    shutdownFidoAgentSubsystem();
    const pipe = "\\\\.\\pipe\\netcatty-fido-agent-testown";
    const agent = await acquireFidoAgent({
      platform: "win32",
      resolveWebContents: () => null,
      env: { PATH: process.env.PATH || "", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async (_bin, args, opts) => {
        assert.ok(opts?.env?.SSH_ASKPASS, "child agent must inherit askpass");
        assert.equal(opts?.env?.NETCATTY_FIDO_ASKPASS_LEASE, undefined);
        assert.ok(Array.isArray(args) && args.includes("-a"));
        return {
          stdout: `SSH_AUTH_SOCK=${pipe}; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=4242; export SSH_AGENT_PID;\n`,
        };
      },
    });
    assert.equal(agent.socketPath, pipe);
    assert.equal(agent.owned, true);
    assert.ok(agent.askpassEnv?.SSH_ASKPASS);
    releaseFidoAgent(agent.generation);
  });
});

test("acquireFidoAgent on win32 falls back to system pipe when child agent cannot start", async () => {
  await withManagedTemp(async () => {
    shutdownFidoAgentSubsystem();
    const agent = await acquireFidoAgent({
      platform: "win32",
      resolveWebContents: () => null,
      env: { PATH: process.env.PATH || "", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => {
        throw new Error("ssh-agent -a unsupported");
      },
    });
    assert.equal(agent.socketPath, "\\\\.\\pipe\\openssh-ssh-agent");
    assert.equal(agent.owned, false);
    assert.ok(agent.askpassEnv?.SSH_ASKPASS);
    releaseFidoAgent(agent.generation);
  });
});

test("acquireFidoAgent on win32 does not claim ownership of the system service pipe", async () => {
  await withManagedTemp(async () => {
    shutdownFidoAgentSubsystem();
    const systemPipe = "\\\\.\\pipe\\openssh-ssh-agent";
    const agent = await acquireFidoAgent({
      platform: "win32",
      resolveWebContents: () => null,
      env: { PATH: process.env.PATH || "", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => ({
        stdout: `SSH_AUTH_SOCK=${systemPipe}; export SSH_AUTH_SOCK;\n`,
      }),
    });
    assert.equal(agent.socketPath, systemPipe);
    assert.equal(agent.owned, false);
    releaseFidoAgent(agent.generation);
  });
});

test("acquireFidoAgent releases askpass lease when agent start fails", async () => {
  shutdownFidoAgentSubsystem();
  const fs = require("node:fs");
  const path = require("node:path");
  const tempDirBridge = require("./tempDirBridge.cjs");
  const { getAskpassLeaseCountForTests } = require("./fidoAskpass.cjs");
  const managedTemp = fs.mkdtempSync(path.join(__dirname, "netcatty-fido-lease-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  tempDirBridge.getTempDir = () => managedTemp;
  const before = getAskpassLeaseCountForTests();
  try {
    await assert.rejects(
      () => acquireFidoAgent({
        platform: "linux",
        resolveWebContents: () => ({ id: "fail-start" }),
        env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
        execFile: async () => {
          throw new Error("ssh-agent missing");
        },
      }),
      (error) => error?.code === "ERR_FIDO_AGENT_START",
    );
    assert.equal(getAskpassLeaseCountForTests(), before);
  } finally {
    tempDirBridge.getTempDir = originalGetTempDir;
    shutdownFidoAgentSubsystem();
    fs.rmSync(managedTemp, { recursive: true, force: true });
  }
});

test("askpassEnvForAgentProcess strips caller-bound askpass lease", () => {
  const { askpassEnvForAgentProcess } = require("./fidoAgentManager.cjs");
  const stripped = askpassEnvForAgentProcess({
    SSH_ASKPASS: "/tmp/askpass.sh",
    SSH_ASKPASS_REQUIRE: "force",
    NETCATTY_FIDO_ASKPASS_SOCK: "/tmp/askpass.sock",
    NETCATTY_FIDO_ASKPASS_LEASE: "starter-lease",
  });
  assert.equal(stripped.SSH_ASKPASS, "/tmp/askpass.sh");
  assert.equal(stripped.NETCATTY_FIDO_ASKPASS_SOCK, "/tmp/askpass.sock");
  assert.equal(stripped.SSH_ASKPASS_REQUIRE, "force");
  assert.equal("NETCATTY_FIDO_ASKPASS_LEASE" in stripped, false);
});

test("ssh-agent spawn env omits caller-bound askpass lease", async () => {
  shutdownFidoAgentSubsystem();
  const fs = require("node:fs");
  const path = require("node:path");
  const tempDirBridge = require("./tempDirBridge.cjs");
  const { releaseFidoAskpassLease } = require("./fidoAskpass.cjs");
  const managedTemp = fs.mkdtempSync(path.join(__dirname, "netcatty-fido-agent-env-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  tempDirBridge.getTempDir = () => managedTemp;
  const sockPath = path.join(managedTemp, "agent.sock");
  fs.writeFileSync(sockPath, "");
  /** @type {Record<string, string>|null} */
  let spawnEnv = null;

  try {
    const acquired = await acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "starter" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async (_bin, _args, opts) => {
        spawnEnv = opts?.env || null;
        return {
          stdout: `SSH_AUTH_SOCK=${sockPath}; export SSH_AUTH_SOCK;\n`,
        };
      },
    });
    assert.ok(spawnEnv);
    assert.ok(spawnEnv.SSH_ASKPASS);
    assert.equal(spawnEnv.NETCATTY_FIDO_ASKPASS_LEASE, undefined);
    assert.ok(acquired.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAskpassLease(acquired.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAgent(acquired.generation);
  } finally {
    tempDirBridge.getTempDir = originalGetTempDir;
    shutdownFidoAgentSubsystem();
    fs.rmSync(managedTemp, { recursive: true, force: true });
  }
});

test("concurrent acquireFidoAgent returns a fresh askpass lease per caller", async () => {
  await withManagedTemp(async (managedTemp) => {
    shutdownFidoAgentSubsystem();
    const fs = require("node:fs");
    const path = require("node:path");
    const { releaseFidoAskpassLease } = require("./fidoAskpass.cjs");
    const sockPath = path.join(managedTemp, "agent.sock");
    fs.writeFileSync(sockPath, "");
    let releaseStart;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });

    const first = acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "first" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => {
        releaseStart();
        await new Promise((r) => setTimeout(r, 80));
        return {
          stdout: `SSH_AUTH_SOCK=${sockPath}; export SSH_AUTH_SOCK;\n`,
        };
      },
    });

    await startGate;
    const second = acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "second" }),
      execFile: async () => {
        throw new Error("second caller must await startingPromise");
      },
    });

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.socketPath, sockPath);
    assert.equal(b.socketPath, sockPath);
    assert.notEqual(
      a.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE,
      b.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE,
    );
    releaseFidoAskpassLease(a.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAskpassLease(b.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAgent(a.generation);
    releaseFidoAgent(b.generation);
  });
});

test("stale releaseFidoAgent ignores a newer agent generation", async () => {
  shutdownFidoAgentSubsystem();
  const fs = require("node:fs");
  const path = require("node:path");
  const tempDirBridge = require("./tempDirBridge.cjs");
  const { releaseFidoAskpassLease } = require("./fidoAskpass.cjs");
  const managedTemp = fs.mkdtempSync(path.join(__dirname, "netcatty-fido-gen-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  tempDirBridge.getTempDir = () => managedTemp;
  const firstSock = path.join(managedTemp, "agent1.sock");
  const secondSock = path.join(managedTemp, "agent2.sock");
  fs.writeFileSync(firstSock, "");
  fs.writeFileSync(secondSock, "");

  try {
    const first = await acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "gen-first" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => ({
        stdout: `SSH_AUTH_SOCK=${firstSock}; export SSH_AUTH_SOCK;\n`,
      }),
    });
    assert.equal(getActiveFidoAgentSocket(), firstSock);

    // Simulate the managed agent dying while a connection still holds a release.
    fs.rmSync(firstSock, { force: true });
    assert.equal(isAgentLive(), false);

    const second = await acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "gen-second" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => ({
        stdout: `SSH_AUTH_SOCK=${secondSock}; export SSH_AUTH_SOCK;\n`,
      }),
    });
    assert.notEqual(first.generation, second.generation);
    assert.equal(getActiveFidoAgentSocket(), secondSock);

    // Late close of the old connection must not kill the replacement agent.
    releaseFidoAgent(first.generation);
    assert.equal(getActiveFidoAgentSocket(), secondSock);
    assert.equal(isAgentLive(), true);

    releaseFidoAskpassLease(first.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAskpassLease(second.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAgent(second.generation);
    assert.equal(getActiveFidoAgentSocket(), null);
  } finally {
    tempDirBridge.getTempDir = originalGetTempDir;
    shutdownFidoAgentSubsystem();
    fs.rmSync(managedTemp, { recursive: true, force: true });
  }
});
