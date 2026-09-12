"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { listInteractiveShellPids } = require("./sshInteractiveShells.cjs");
const {
  borrowTransport,
  createTransport,
  resetSshTransportRegistryForTests,
} = require("./sshConnectionPool.cjs");

test("shell PID discovery timeout preserves active shared shell channels", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));

  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn.endCalls = 0;
  conn.destroyCalls = 0;
  conn.execCalls = 0;
  conn.exec = (_command, callback) => {
    conn.execCalls += 1;
    conn.pendingExecCallback = callback;
  };
  conn.end = () => {
    conn.endCalls += 1;
    conn.emit("close");
  };
  conn.destroy = () => {
    conn.destroyCalls += 1;
    conn._sock.destroyed = true;
  };

  const transport = createTransport({
    conn,
    endpoint: { hostname: "shared.example", username: "alice" },
  });
  const firstShell = { stream: new EventEmitter() };
  const secondShell = { stream: new EventEmitter() };
  let closedShellChannels = 0;
  firstShell.stream.once("close", () => { closedShellChannels += 1; });
  secondShell.stream.once("close", () => { closedShellChannels += 1; });
  conn.once("close", () => {
    firstShell.stream.emit("close");
    secondShell.stream.emit("close");
  });
  borrowTransport(transport, {
    kind: "shell",
    holder: firstShell,
    meta: { activeShellChannel: true },
  });
  borrowTransport(transport, {
    kind: "shell",
    holder: secondShell,
    meta: { activeShellChannel: true },
  });

  const result = await listInteractiveShellPids(conn, {
    quoteShellArg: (value) => JSON.stringify(value),
    openingTimeoutMs: 2,
  });
  const skippedRetry = await listInteractiveShellPids(conn, {
    quoteShellArg: (value) => JSON.stringify(value),
    openingTimeoutMs: 2,
  });

  assert.equal(result.openTimedOut, true);
  assert.equal(skippedRetry.disabled, true);
  assert.equal(conn.execCalls, 1, "a timed-out connection must not accumulate discovery callbacks");
  assert.equal(conn.endCalls, 0, "best-effort discovery must not end the shared connection");
  assert.equal(conn.destroyCalls, 0, "best-effort discovery must not destroy the shared connection");
  assert.equal(closedShellChannels, 0, "a discovery timeout must not close sibling shells");
  assert.equal(transport.state, "live");
  assert.equal(transport.leases.size, 2);
});
