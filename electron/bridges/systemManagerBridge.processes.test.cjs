"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSystemManagerBridge } = require("./systemManagerBridge.cjs");

function createFakeExecStream(stdout) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  process.nextTick(() => {
    stream.emit("data", stdout);
    stream.emit("close", 0);
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
