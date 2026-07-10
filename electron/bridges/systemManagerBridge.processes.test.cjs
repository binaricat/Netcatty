"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
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

function runProcessCommandWithBusyBoxPs(command, { supportsWide = true } = {}) {
  const prefix = "exec sh -c '";
  assert.ok(command.startsWith(prefix) && command.endsWith("'"));
  const innerScript = command.slice(prefix.length, -1);
  const processOutput = [
    "  PID USER       VSZ STAT COMMAND",
    "    1 root      1356 S    /sbin/procd",
    "  411 root     97.6m S    /sbin/ubusd",
  ];
  const printProcessOutput = processOutput
    .map((line) => `printf '%s\\n' '${line}'`)
    .join("\n");
  const fakePs = [
    "exec 3>&2",
    "ps() {",
    "  printf '__PS_CALL__=%s\\n' \"$*\" >&3",
    "  if [ \"$1\" = '-eo' ]; then",
    "    printf '%s\\n' 'ps: unrecognized option: e' >&2",
    "    return 1",
    "  fi",
    "  if [ \"$#\" -eq 1 ] && [ \"$1\" = 'ww' ]; then",
    supportsWide ? printProcessOutput : "    return 1",
    "    return 0",
    "  fi",
    "  if [ \"$#\" -eq 0 ]; then",
    printProcessOutput,
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    innerScript,
  ].join("\n");
  const result = spawnSync("sh", ["-c", fakePs], { encoding: "utf8" });
  const calls = String(result.stderr || "")
    .split("\n")
    .filter((line) => line.startsWith("__PS_CALL__="))
    .map((line) => line.slice("__PS_CALL__=".length));
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    code: result.status ?? 1,
    calls,
  };
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

  let seenCommand = "";
  const conn = {
    exec(command, callback) {
      seenCommand = command;
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
  assert.doesNotMatch(seenCommand, /head\s+-n\s+2000/);
});

test("listProcesses returns processes from the default OpenWrt BusyBox ps format", async () => {
  let seenCommand = "";
  let seenPsCalls = [];
  const conn = {
    exec(command, callback) {
      seenCommand = command;
      const execution = runProcessCommandWithBusyBoxPs(command);
      seenPsCalls = execution.calls;
      callback(null, createFakeExecStream(execution.stdout, execution));
    },
  };
  const sessions = new Map([["openwrt", { conn, type: "ssh" }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
  });

  const result = await bridge.listProcesses(null, { sessionId: "openwrt" });

  assert.equal(result.success, true);
  assert.equal(result.processes.length, 2);
  assert.deepEqual(result.processes[0], {
    pid: 1,
    ppid: 0,
    user: "root",
    stat: "S",
    cpuPercent: 0,
    memPercent: 0,
    rssKb: 0,
    vszKb: 1356,
    elapsed: "",
    command: "/sbin/procd",
  });
  assert.equal(result.processes[1].vszKb, 99942);
  assert.match(seenCommand, /ps ww/);
  assert.equal(seenPsCalls.length, 2);
  assert.match(seenPsCalls[0], /^-eo pid=/);
  assert.equal(seenPsCalls[1], "ww");
});

test("listProcesses falls back to plain BusyBox ps when wide output is unavailable", async () => {
  let seenPsCalls = [];
  const conn = {
    exec(command, callback) {
      const execution = runProcessCommandWithBusyBoxPs(command, { supportsWide: false });
      seenPsCalls = execution.calls;
      callback(null, createFakeExecStream(execution.stdout, execution));
    },
  };
  const sessions = new Map([["openwrt", { conn, type: "ssh" }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
  });

  const result = await bridge.listProcesses(null, { sessionId: "openwrt" });

  assert.equal(result.success, true);
  assert.equal(result.processes.length, 2);
  assert.equal(result.processes[0].command, "/sbin/procd");
  assert.equal(result.processes[1].vszKb, 99942);
  assert.equal(seenPsCalls.length, 3);
  assert.match(seenPsCalls[0], /^-eo pid=/);
  assert.equal(seenPsCalls[1], "ww");
  assert.equal(seenPsCalls[2], "");
});

test("process listing commands do not hard-cap the visible list at 2000 entries", () => {
  const source = fs.readFileSync(path.join(__dirname, "systemManagerBridge.cjs"), "utf8");

  assert.doesNotMatch(source, /head\s+-n\s+2000/);
  assert.doesNotMatch(source, /Select-Object\s+-First\s+2000/);
});

test("listProcesses gives ET process listing enough output buffer for dense hosts", async () => {
  let seenOptions = null;
  const sessions = new Map([["s1", {
    type: "et",
    etStatsAuth: { knownHosts: [] },
  }]]);
  const bridge = createSystemManagerBridge({
    getSessions: () => sessions,
    process,
    execOnEtSession: async (_session, _command, _timeoutMs, options) => {
      seenOptions = options;
      return { success: true, stdout: "" };
    },
  });

  const result = await bridge.listProcesses(null, { sessionId: "s1" });

  assert.equal(result.success, true);
  assert.ok(seenOptions.maxBuffer > 10 * 1024 * 1024);
});

test("listProcesses gives Windows process listing enough output buffer for dense local hosts", () => {
  const source = fs.readFileSync(path.join(__dirname, "systemManagerBridge.cjs"), "utf8");

  assert.match(
    source,
    /execOnLocalMachine\(\s*"Get-CimInstance Win32_Process[\s\S]+10000,\s*\{\s*maxBuffer:\s*PROCESS_LIST_MAX_BUFFER\s*\}/,
  );
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
