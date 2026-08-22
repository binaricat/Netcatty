"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  resolveFidoAskpassSocketPath,
  isWindowsNamedPipePath,
} = require("./fidoAskpass.cjs");

test("resolveFidoAskpassSocketPath uses Windows named-pipe namespace on win32", () => {
  const sock = resolveFidoAskpassSocketPath("C:\\Users\\netcatty\\Temp\\askpass-base", "win32");
  assert.equal(isWindowsNamedPipePath(sock), true);
  assert.match(sock, /^\\\\\.\\pipe\\netcatty-fido-askpass-/);
  assert.equal(path.isAbsolute(sock), false);
});

test("resolveFidoAskpassSocketPath uses filesystem sockets on unix", () => {
  const sock = resolveFidoAskpassSocketPath("/tmp/netcatty-fido-askpass-abcd", "linux");
  assert.equal(sock, "/tmp/netcatty-fido-askpass-abcd/askpass.sock");
  assert.equal(isWindowsNamedPipePath(sock), false);
});
