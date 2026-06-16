"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isSshConnAlive, isTransportExecError } = require("./execConnHealth.cjs");

describe("isSshConnAlive", () => {
  it("returns false for missing conn", () => {
    assert.equal(isSshConnAlive(null), false);
  });

  it("returns false when socket is destroyed", () => {
    assert.equal(isSshConnAlive({ _sock: { destroyed: true } }), false);
  });

  it("returns true when socket is alive", () => {
    assert.equal(isSshConnAlive({ _sock: { destroyed: false } }), true);
    assert.equal(isSshConnAlive({}), true);
  });
});

describe("isTransportExecError", () => {
  it("detects common ssh2 transport failures", () => {
    assert.equal(isTransportExecError("Not connected"), true);
    assert.equal(isTransportExecError("Channel open failure: open failed"), true);
    assert.equal(isTransportExecError("read ECONNRESET"), true);
  });

  it("ignores unrelated command errors", () => {
    assert.equal(isTransportExecError("docker: no such container"), false);
    assert.equal(isTransportExecError("permission denied"), false);
  });
});
