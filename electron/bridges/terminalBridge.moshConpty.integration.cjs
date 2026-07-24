"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

function waitFor(predicate, description, timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function main() {
  assert.equal(process.platform, "win32", "Windows ConPTY only");
  const fakeSsh = process.env.NETCATTY_TEST_MOSH_SSH_EXE;
  const fakeClient = process.env.NETCATTY_TEST_MOSH_CLIENT_EXE;
  assert.ok(fakeSsh && fs.existsSync(fakeSsh), "compiled fake ssh executable is required");
  assert.ok(fakeClient && fs.existsSync(fakeClient), "compiled fake mosh-client executable is required");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-conpty-"));
  const binDir = path.join(tmp, "bin");
  const resourcesPath = path.join(tmp, "resources");
  const clientDir = path.join(tmp, "project", "resources", "mosh", "win32-x64");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });
  fs.copyFileSync(fakeSsh, path.join(binDir, "ssh.exe"));
  fs.copyFileSync(fakeClient, path.join(clientDir, "mosh-client.exe"));

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];
  const originalLoad = Module._load;
  Module._load = function loadWithoutElectronBinary(request, parent, isMain) {
    if (request === "electron") {
      return { dialog: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let bridge;
  try {
    bridge = require("./terminalBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
  const sessions = new Map();
  const sent = [];
  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  try {
    const sessionId = "mosh-conpty-integration";
    await bridge.startMoshSession(
      { sender: { id: 77 } },
      {
        sessionId,
        hostname: "example.com",
        username: "alice",
        authMethod: "password",
        password: "netcatty-test-password",
        cols: 80,
        rows: 24,
        env: { PATH: process.env.PATH },
      },
      {
        moshClientLookup: {
          platform: "win32",
          arch: "x64",
          projectRoot: path.join(tmp, "project"),
          resourcesPath,
        },
      },
    );

    await waitFor(
      () => sent.some((entry) => entry.channel === "netcatty:mosh:ready"),
      "mosh ready event",
    );
    await waitFor(
      () => sent.some((entry) => entry.channel === "netcatty:data"
        && String(entry.payload?.data).includes("MOSHCATTY_TEST_READY")),
      "mosh-client output",
    );

    const output = sent
      .filter((entry) => entry.channel === "netcatty:data")
      .map((entry) => String(entry.payload?.data || ""))
      .join("");
    assert.match(output, /key=ABCDEFGHIJKLMNOPQRSTUV==/);
    assert.match(output, /args=127\.0\.0\.1\|60002/);
    assert.match(output, /fallback=example\.com/);
    assert.equal(sessions.get(sessionId)?.moshHandshakePhase, "mosh-client");

    bridge.writeToSession(null, { sessionId, data: "hello-from-conpty\r" });
    await waitFor(
      () => sent.some((entry) => entry.channel === "netcatty:data"
        && String(entry.payload?.data).includes("MOSHCATTY_TEST_ECHO=hello-from-conpty")),
      "input routed to mosh-client",
    );

    bridge.writeToSession(null, { sessionId, data: "quit\r" });
    await waitFor(() => !sessions.has(sessionId), "mosh-client exit");
  } finally {
    bridge.cleanupAllSessions();
    process.env.PATH = oldPath;
    delete require.cache[bridgePath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log("Windows ConPTY Mosh handoff passed");
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
