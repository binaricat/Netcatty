import assert from "node:assert/strict";
import test from "node:test";

import { handleSerialLineModeInput } from "./serialLineInput";

test("serial line mode sends completed lines from a multi-line paste chunk", () => {
  const writes: string[] = [];
  const echoes: string[] = [];
  const bufferRef = { current: "" };

  handleSerialLineModeInput("show version\rshow clock", {
    bufferRef,
    writeToSession: (data) => writes.push(data),
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.deepEqual(writes, ["show version\r"]);
  assert.equal(bufferRef.current, "show clock");
  assert.deepEqual(echoes, []);
});

test("serial line mode sends every completed line when pasted text ends with enter", () => {
  const writes: string[] = [];
  const echoes: string[] = [];
  const bufferRef = { current: "" };

  handleSerialLineModeInput("show version\rshow clock\r", {
    bufferRef,
    localEcho: true,
    writeToSession: (data) => writes.push(data),
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.deepEqual(writes, ["show version\r", "show clock\r"]);
  assert.equal(bufferRef.current, "");
  assert.deepEqual(echoes, ["show version", "\r\n", "show clock", "\r\n"]);
});
