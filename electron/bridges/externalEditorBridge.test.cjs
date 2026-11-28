"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SSH_CONFIG_MARKER_START,
  SSH_CONFIG_MARKER_END,
  buildSshBridgeConfigBlock,
  upsertSshBridgeConfigContent,
  removeSshBridgeConfigContent,
  installSshBridgeConfig,
  removeSshBridgeConfig,
  getSshBridgeConfigStatus,
  detectInstalledEditors,
  buildLaunchSpec,
  createExternalEditorBridge,
} = require("./externalEditorBridge.cjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("installSshBridgeConfig preserves existing user ~/.ssh/config and cleanly removes only Netcatty block", () => {
  const tmpDir = makeTempDir("nc-ext-editor-cfg-");
  const sshConfigPath = path.join(tmpDir, ".ssh", "config");
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(path.dirname(sshConfigPath), { recursive: true });

  const userConfig = [
    "Host github.com",
    "    User git",
    "    IdentityFile ~/.ssh/id_github",
    "",
  ].join("\n");
  fs.writeFileSync(sshConfigPath, userConfig, "utf8");

  try {
    const installed = installSshBridgeConfig({
      sshConfigPath,
      stateDir,
      proxyLauncherPath: "/opt/netcatty/netcatty-ssh-proxy",
      platform: "linux",
    });
    assert.equal(installed.installed, true);
    assert.equal(installed.upToDate, true);

    const contentAfterInstall = fs.readFileSync(sshConfigPath, "utf8");
    assert.ok(contentAfterInstall.includes("Host github.com"));
    assert.ok(contentAfterInstall.includes(SSH_CONFIG_MARKER_START));
    assert.ok(contentAfterInstall.includes("Host *.netcatty"));
    assert.ok(contentAfterInstall.includes("StrictHostKeyChecking yes"));
    assert.ok(contentAfterInstall.includes(SSH_CONFIG_MARKER_END));

    // Re-installing updates in place without duplicating blocks.
    installSshBridgeConfig({
      sshConfigPath,
      stateDir,
      proxyLauncherPath: "/opt/netcatty/netcatty-ssh-proxy",
      platform: "linux",
    });
    const contentAfterReinstall = fs.readFileSync(sshConfigPath, "utf8");
    assert.equal(contentAfterReinstall.split(SSH_CONFIG_MARKER_START).length, 2);

    // Removing restores user config cleanly.
    const removed = removeSshBridgeConfig({
      sshConfigPath,
      stateDir,
      proxyLauncherPath: "/opt/netcatty/netcatty-ssh-proxy",
      platform: "linux",
    });
    assert.equal(removed.installed, false);
    const contentAfterRemove = fs.readFileSync(sshConfigPath, "utf8");
    assert.ok(contentAfterRemove.includes("Host github.com"));
    assert.ok(!contentAfterRemove.includes("Host *.netcatty"));
    assert.ok(!contentAfterRemove.includes(SSH_CONFIG_MARKER_START));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildSshBridgeConfigBlock normalizes Windows paths with forward slashes for OpenSSH", () => {
  const block = buildSshBridgeConfigBlock({
    proxyLauncherPath: "C:\\Program Files\\Netcatty\\resources\\app.asar.unpacked\\electron\\cli\\netcatty-ssh-proxy.cmd",
    knownHostsPath: "C:\\Users\\Alice\\AppData\\Roaming\\Netcatty Dev\\dev\\ssh-bridge\\known_hosts",
    discoveryPath: "C:\\Users\\Alice\\AppData\\Roaming\\Netcatty Dev\\dev\\ssh-bridge\\discovery.json",
    platform: "win32",
  });
  assert.ok(
    block.includes(
      'ProxyCommand "C:/Program Files/Netcatty/resources/app.asar.unpacked/electron/cli/netcatty-ssh-proxy.cmd" %h "C:/Users/Alice/AppData/Roaming/Netcatty Dev/dev/ssh-bridge/discovery.json"',
    ),
  );
  assert.ok(block.includes('UserKnownHostsFile "C:/Users/Alice/AppData/Roaming/Netcatty Dev/dev/ssh-bridge/known_hosts"'));

  const upserted = upsertSshBridgeConfigContent("", block);
  assert.equal(removeSshBridgeConfigContent(upserted), "");
});

test("detectInstalledEditors finds Windows Zed and VS Code binaries cleanly", () => {
  const existing = new Set([
    path.join("C:\\Users\\dev\\AppData\\Local", "Programs", "Zed", "Zed.exe"),
    path.join("C:\\Users\\dev\\AppData\\Local", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
  ]);
  const detected = detectInstalledEditors({
    platform: "win32",
    homedir: "C:\\Users\\dev",
    env: {
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      PATH: "",
    },
    existsSync: (p) => existing.has(p),
  });
  assert.equal(detected.zed.available, true);
  assert.ok(detected.zed.detectedPath.endsWith("Zed.exe"));
  assert.equal(detected.vscode.available, true);
  assert.equal(detected.cursor.available, false);
});

test("buildLaunchSpec uses structured argv and never injects shell strings", () => {
  const zedSpec = buildLaunchSpec({
    editorId: "zed",
    executablePath: "C:\\Users\\dev\\AppData\\Local\\Programs\\Zed\\Zed.exe",
    sshTarget: "prod-1234abcd.netcatty",
    remotePath: "/home/dev/a; rm -rf /; b",
    kind: "dir",
    platform: "win32",
  });
  assert.equal(zedSpec.command, "C:\\Users\\dev\\AppData\\Local\\Programs\\Zed\\Zed.exe");
  assert.deepEqual(zedSpec.args, ["ssh://prod-1234abcd.netcatty/home/dev/a%3B%20rm%20-rf%20/%3B%20b"]);

  assert.throws(() => buildLaunchSpec({
    editorId: "evil-shell",
    executablePath: "/bin/sh",
    sshTarget: "prod-1234abcd.netcatty",
    remotePath: "/tmp",
    platform: "linux",
  }));
});

test("openRemoteInExternalEditor registers bridge target and spawns with shell: false", async () => {
  const tmpDir = makeTempDir("nc-ext-editor-launch-");
  const spawns = [];
  const registered = [];

  const fakeSpawn = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  const bridge = createExternalEditorBridge({
    stateDir: path.join(tmpDir, "state"),
    platform: "linux",
    spawnImpl: fakeSpawn,
    sshChannelBridge: {
      async registerTarget(payload) {
        registered.push(payload);
        return { running: true, connected: true, bridgeHost: payload.bridgeHost };
      },
    },
  });

  // Override HOME for `~/.ssh/config` isolation during test.
  const origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  try {
    const result = await bridge.openRemoteInExternalEditor({
      editorId: "zed",
      executablePath: "/usr/bin/zed",
      connectionMode: "bridge",
      bridgeHost: "web-deadbeef.netcatty",
      sessionId: "sess-42",
      hostId: "h-42",
      hostname: "10.0.0.9",
      port: 22,
      username: "deploy",
      remotePath: "/srv/app/main.ts",
      kind: "file",
    });

    assert.equal(result.ok, true);
    assert.equal(result.displayUri, "ssh://web-deadbeef.netcatty/srv/app/main.ts");
    assert.equal(registered.length, 1);
    assert.equal(registered[0].sessionId, "sess-42");
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cmd, "/usr/bin/zed");
    assert.deepEqual(spawns[0].args, ["ssh://web-deadbeef.netcatty/srv/app/main.ts"]);
    assert.equal(spawns[0].opts.shell, false);

    const cfgStatus = getSshBridgeConfigStatus({
      homedir: tmpDir,
      stateDir: path.join(tmpDir, "state"),
      platform: "linux",
    });
    assert.equal(cfgStatus.installed, true);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
