"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const bridge = require("./sftpBridge.cjs");

for (const loggerThrows of [false, true]) {
  test(`Auto fallback reports the channel failure; loggerThrows=${loggerThrows}`, async () => {
    const failure = Object.assign(new Error("subsystem request rejected"), { code: "CHANNEL_OPEN_FAILURE" });
    const reports = [];
    const conn = {
      sftp(callback) { callback(failure); },
      exec(command, callback) {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        callback(null, stream);
        queueMicrotask(() => {
          if (!command.includes("command -v scp")) {
            stream.emit("data", Buffer.from("RAW:/home/test\n"));
          }
          stream.emit("close", 0);
        });
      },
    };
    bridge.init({
      electronModule: { webContents: { fromId: () => null } },
      sessions: new Map([["fallback-session", { conn }]]),
      sftpClients: new Map(),
      reportSuppressedError(...args) {
        reports.push(args);
        if (loggerThrows) throw new Error("logger unavailable");
      },
    });
    const opened = await bridge.openSftpForSession(null, { sessionId: "fallback-session" });
    try {
      assert.equal(opened.fileProtocol, "scp");
      assert.equal(reports.length, 1);
      assert.equal(reports[0][0], "sftpBridge.openSftpForSession");
      assert.equal(reports[0][1], failure);
      assert.match(reports[0][2], /fallback-session.*SCP mode \(auto\)/);
    } finally {
      await bridge.closeSftp(null, { sftpId: opened.sftpId });
    }
  });
}
