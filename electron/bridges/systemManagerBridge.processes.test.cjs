"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSystemManagerBridge } = require("./systemManagerBridge.cjs");

function createFakeExecStream(stdout, options = {}) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  process.nextTick(() => {
    if (stdout) stream.emit("data", stdout);
    if (options.stderr) stream.stderr.emit("data", options.stderr);
    stream.emit("close", options.code ?? 0);
  });
  return stream;
}

test("listProcesses uses a ps format that works on CentOS 7 procps", async () => {
  const compatiblePsFormat = "ps -eo pid= -o ppid= -o user= -o stat= -o pcpu= -o pmem= -o rss= -o vsz= -o etime= -o args=";
  const badCentos7Output = [
    ",ppid=,user=,stat=,pcpu=,pmem=,rss=,vsz=,etime=,args=",
    "                                                    1",
  ].join("\n");
  const compatibleOutput = [
    "     1      0 root     Ss    0.0  0.0  4060 191024  2-19:23:42 /usr/lib/systemd/systemd --switched-root --system --deserialize 21",
  ].join("\n");

  const conn = {
    exec(command, callback) {
      const stdout = command.includes(compatiblePsFormat)
        ? compatibleOutput
        : badCentos7Output;
      callback(null, createFakeExecStream(stdout));
    },
  };
  const sessions = new Map([["s1", { conn, type: "ssh" }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
  });

  const result = await bridge.listProcesses(null, { sessionId: "s1" });

  assert.equal(result.success, true);
  assert.equal(result.processes.length, 1);
  assert.equal(result.processes[0].pid, 1);
  assert.equal(result.processes[0].command, "/usr/lib/systemd/systemd --switched-root --system --deserialize 21");
});

test("probeCapabilities reports Docker when docker is installed even if plain docker access is denied", async () => {
  const conn = {
    exec(command, callback) {
      assert.match(command, /command -v docker/);
      assert.doesNotMatch(command, /docker info/);
      assert.doesNotMatch(command, /docker\.sock/);
      callback(null, createFakeExecStream("__NC_OS__=Linux\n__NC_DOCKER__=1\n"));
    },
  };
  const sessions = new Map([["s1", { conn, type: "ssh" }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
  });

  const result = await bridge.probeCapabilities(null, { sessionId: "s1" });

  assert.equal(result.success, true);
  assert.equal(result.capabilities.hasDocker, true);
});

test("setupOsc7Tracking runs the setup command through the active session executor", async () => {
  let seenCommand = "";
  const conn = {
    exec(command, callback) {
      seenCommand = command;
      callback(null, createFakeExecStream("__NETCATTY_OSC7_SETUP_SHELL__=bash\n"));
    },
  };
  const sessions = new Map([["s1", { conn, type: "ssh" }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
  });

  const result = await bridge.setupOsc7Tracking(null, {
    sessionId: "s1",
    command: "printf setup-script",
  });

  assert.equal(result.success, true);
  assert.equal(result.stdout, "__NETCATTY_OSC7_SETUP_SHELL__=bash\n");
  assert.equal(seenCommand, "printf setup-script");
});

test("setupOsc7Tracking reports non-zero setup exits as failures", async () => {
  const conn = {
    exec(_command, callback) {
      callback(null, createFakeExecStream("", { code: 2, stderr: "unsupported shell\n" }));
    },
  };
  const sessions = new Map([["s1", { conn, type: "ssh" }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
  });

  const result = await bridge.setupOsc7Tracking(null, {
    sessionId: "s1",
    command: "printf setup-script",
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 2);
  assert.match(result.error, /unsupported shell/);
});
