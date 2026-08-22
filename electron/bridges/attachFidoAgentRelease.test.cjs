"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachFidoAgentRelease } = require("./attachFidoAgentRelease.cjs");

test("attachFidoAgentRelease invokes release once on close", () => {
  const conn = new EventEmitter();
  let releaseCount = 0;
  const agent = {
    _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
  };

  attachFidoAgentRelease(conn, agent);
  conn.emit("close");

  assert.equal(releaseCount, 1);
  conn.emit("close");
  assert.equal(releaseCount, 1);
});

test("attachFidoAgentRelease invokes release once on end", () => {
  const conn = new EventEmitter();
  let releaseCount = 0;
  const agent = {
    _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
  };

  attachFidoAgentRelease(conn, agent);
  conn.emit("end");

  assert.equal(releaseCount, 1);
  conn.emit("end");
  assert.equal(releaseCount, 1);
});

test("attachFidoAgentRelease is one-shot across close and end", () => {
  const conn = new EventEmitter();
  let releaseCount = 0;
  const agent = {
    _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
  };

  attachFidoAgentRelease(conn, agent);
  conn.emit("close");
  conn.emit("end");

  assert.equal(releaseCount, 1);
});

test("attachFidoAgentRelease no-ops without conn or release hook", () => {
  let releaseCount = 0;
  const agent = {
    _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
  };

  attachFidoAgentRelease(null, agent);
  attachFidoAgentRelease(new EventEmitter(), null);
  attachFidoAgentRelease(new EventEmitter(), {});

  assert.equal(releaseCount, 0);
});
