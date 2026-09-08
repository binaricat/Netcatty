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

test("serial line mode backspace erases one cell for ASCII characters", () => {
  const echoes: string[] = [];
  const bufferRef = { current: "abc" };

  handleSerialLineModeInput("\x7f", {
    bufferRef,
    localEcho: true,
    writeToSession: () => {},
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.equal(bufferRef.current, "ab");
  assert.deepEqual(echoes, ["\b \b"]); // 1 cell erased
});

test("serial line mode backspace erases two cells for CJK characters", () => {
  const echoes: string[] = [];
  const bufferRef = { current: "你好" };

  handleSerialLineModeInput("\x7f", {
    bufferRef,
    localEcho: true,
    writeToSession: () => {},
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.equal(bufferRef.current, "你");
  assert.deepEqual(echoes, ["\b \b\b \b"]); // 2 cells erased
});

test("serial line mode backspace erases two cells for fullwidth characters", () => {
  const echoes: string[] = [];
  const bufferRef = { current: "test！" };

  handleSerialLineModeInput("\b", {
    bufferRef,
    localEcho: true,
    writeToSession: () => {},
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.equal(bufferRef.current, "test");
  assert.deepEqual(echoes, ["\b \b\b \b"]); // 2 cells erased
});

test("serial line mode backspace on empty buffer does nothing", () => {
  const echoes: string[] = [];
  const bufferRef = { current: "" };

  handleSerialLineModeInput("\x7f", {
    bufferRef,
    localEcho: true,
    writeToSession: () => {},
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.equal(bufferRef.current, "");
  assert.deepEqual(echoes, []);
});

test("serial line mode backspace removes full surrogate pair for CJK Extension B", () => {
  const echoes: string[] = [];
  const extB = "\u{20000}"; // CJK Extension B, stored as surrogate pair
  const bufferRef = { current: "a" + extB };

  handleSerialLineModeInput("\x7f", {
    bufferRef,
    localEcho: true,
    writeToSession: () => {},
    writeToTerminal: (data) => echoes.push(data),
  });

  // Buffer should have "a" remaining (surrogate pair fully removed).
  assert.equal(bufferRef.current, "a");
  // Two cells erased for the wide character.
  assert.deepEqual(echoes, ["\b \b\b \b"]);
});

test("serial line mode backspace removes full surrogate pair for emoji", () => {
  const echoes: string[] = [];
  const emoji = "\u{1F600}"; // Grinning face, stored as surrogate pair
  const bufferRef = { current: "hi" + emoji };

  handleSerialLineModeInput("\x7f", {
    bufferRef,
    localEcho: true,
    writeToSession: () => {},
    writeToTerminal: (data) => echoes.push(data),
  });

  assert.equal(bufferRef.current, "hi");
  assert.deepEqual(echoes, ["\b \b\b \b"]);
});
