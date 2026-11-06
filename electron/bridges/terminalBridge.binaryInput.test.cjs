const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreloadApi } = require("../preload/api.cjs");
const terminalBridge = require("./terminalBridge.cjs");

function setup(session) {
  terminalBridge.init({ sessions: new Map([["session", session]]) });
  const sent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      send(channel, payload) {
        sent.push({ channel, payload });
        // Model Electron structured-clone IPC, including the binary flag.
        terminalBridge.writeToSession({}, structuredClone(payload));
      },
    },
    webUtils: {},
  });
  return { api, sent };
}

for (const transport of ["stream", "proc", "socket", "serialPort"]) {
  for (const encoding of ["utf-8", "gb18030"]) {
    test(`binary input preserves all byte values through preload to ${transport} (${encoding})`, () => {
      const writes = [];
      const { api, sent } = setup({
        type: transport === "serialPort" ? "serial" : "ssh",
        encoding,
        [transport]: { write: (data) => writes.push(data) },
      });
      const bytes = Array.from({ length: 256 }, (_, i) => i);
      const data = String.fromCharCode(...bytes);
      api.writeToSession("session", data, { binary: true });

      assert.equal(sent[0].channel, "netcatty:write");
      assert.equal(sent[0].payload.binary, true);
      assert.equal(sent[0].payload.data, data);
      assert.equal(writes.length, 1);
      assert.ok(Buffer.isBuffer(writes[0]));
      assert.deepEqual([...writes[0]], bytes);
    });
  }
}

test("binary Telnet input preserves bytes and still doubles IAC", () => {
  const writes = [];
  const { api } = setup({
    type: "telnet-native",
    encoding: "gb18030",
    telnetProtocolActive: true,
    socket: { write: (data) => writes.push(data) },
  });
  const bytes = [0x1b, 0x5b, 0x4d, 0x20, 0xc0, 0xff, 0x0d, 0x21, 0x0a];
  api.writeToSession("session", String.fromCharCode(...bytes), { binary: true });
  assert.equal(writes.length, 1);
  assert.ok(Buffer.isBuffer(writes[0]));
  assert.deepEqual([...writes[0]], [0x1b, 0x5b, 0x4d, 0x20, 0xc0, 0xff, 0xff, 0x0d, 0x21, 0x0a]);
});

test("ordinary CJK text retains the default UTF-8 string path", () => {
  const writes = [];
  const { api, sent } = setup({
    type: "ssh",
    encoding: "utf-8",
    stream: { write: (data) => writes.push(data) },
  });
  const text = "\u4e2d\u6587";
  api.writeToSession("session", text);
  assert.equal(sent[0].payload.binary, false);
  assert.deepEqual(writes, [text]);
  assert.deepEqual([...Buffer.from(writes[0], "utf8")], [0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
});
