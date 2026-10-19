"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  resolveFidoAskpassSocketPath,
  isWindowsNamedPipePath,
  selectFidoAskpassWrapper,
} = require("./fidoAskpass.cjs");

test("resolveFidoAskpassSocketPath uses Windows named-pipe namespace on win32", () => {
  const sock = resolveFidoAskpassSocketPath("C:\\Users\\netcatty\\Temp\\askpass-base", "win32");
  assert.equal(isWindowsNamedPipePath(sock), true);
  assert.match(sock, /^\\\\\.\\pipe\\netcatty-fido-askpass-/);
  assert.equal(path.isAbsolute(sock), process.platform === "win32");
});

test("Windows MSYS helpers use a shell wrapper while native OpenSSH keeps its command wrapper", () => {
  const wrapper = "C:\\Users\\First Last\\askpass.cmd";
  const msys = "C:\\msys64\\usr\\bin\\ssh-keygen.exe";
  const native = "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe";
  const files = new Set([msys, native, "C:\\msys64\\usr\\bin\\msys-2.0.dll"]);
  const exists = file => files.has(file);
  assert.equal(selectFidoAskpassWrapper(wrapper, msys, "win32", {}, exists), "C:/Users/First Last/askpass.sh");
  assert.equal(selectFidoAskpassWrapper(wrapper, native, "win32", {}, exists), wrapper);
  assert.equal(selectFidoAskpassWrapper(wrapper, "ssh-keygen", "win32", {
    PATH: "C:\\Windows\\System32\\OpenSSH;C:\\msys64\\usr\\bin",
  }, exists), wrapper, "the first executable on PATH determines the runtime");
});

test("resolveFidoAskpassSocketPath uses filesystem sockets on unix", () => {
  const sock = resolveFidoAskpassSocketPath("/tmp/netcatty-fido-askpass-abcd", "linux");
  assert.equal(sock, "/tmp/netcatty-fido-askpass-abcd/askpass.sock");
  assert.equal(isWindowsNamedPipePath(sock), false);
});
