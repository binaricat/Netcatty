import assert from "node:assert/strict";
import test from "node:test";

import { formatSerialLocalEcho } from "./serialLocalEcho";

test("formatSerialLocalEcho echoes printable input and normalizes newlines", () => {
  assert.equal(formatSerialLocalEcho("show version"), "show version");
  assert.equal(formatSerialLocalEcho("\r"), "\r\n");
  assert.equal(formatSerialLocalEcho("\n"), "\r\n");
  assert.equal(formatSerialLocalEcho("\r\n"), "\r\n");
  assert.equal(formatSerialLocalEcho("one\ntwo"), "one\r\ntwo");
});

test("formatSerialLocalEcho renders local editing control keys", () => {
  assert.equal(formatSerialLocalEcho("\x7f"), "\b \b");
  assert.equal(formatSerialLocalEcho("\b"), "\b \b");
  assert.equal(formatSerialLocalEcho("\x03"), "^C");
});

test("formatSerialLocalEcho ignores single non-display control input", () => {
  assert.equal(formatSerialLocalEcho("\x15"), "");
});

test("formatSerialLocalEcho returns empty for empty input", () => {
  assert.equal(formatSerialLocalEcho(""), "");
});

test("formatSerialLocalEcho erases 1 cell by default for backspace", () => {
  assert.equal(formatSerialLocalEcho("\x7f"), "\b \b");
  assert.equal(formatSerialLocalEcho("\x7f", 1), "\b \b");
});

test("formatSerialLocalEcho erases 2 cells for wide-character backspace", () => {
  // CJK ideograph = 2 cells; backspace must erase both.
  assert.equal(formatSerialLocalEcho("\x7f", 2), "\b \b\b \b");
  assert.equal(formatSerialLocalEcho("\b", 2), "\b \b\b \b");
});

test("serial byte deletion metadata is forwarded through the runtime input loop", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /writeToSession\(id, chunk, \{ sensitive, serialEraseChar \}\)/);
});

test("both Enter and submitted paste restore serial tail confidence", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  const pasteBranch = source.indexOf("const pastedCommand = logicalData");
  const restoreTail = source.indexOf("if (handledSubmittedInput) lastInputWasPrintable = true;");
  const writeInput = source.indexOf("prioritizeTerminalInput(", pasteBranch);
  assert.ok(pasteBranch > 0 && restoreTail > pasteBranch && restoreTail < writeInput);
});

test("byte-oriented serial input prevents encoding changes while wire bytes are pending", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../../Terminal.tsx", import.meta.url), "utf8");
  const handlerStart = source.indexOf("const handleSetTerminalEncoding = useCallback");
  const start = source.indexOf("if (host.protocol === 'serial'", handlerStart);
  const end = source.indexOf("setTerminalEncoding(encoding);", start);
  assert.ok(handlerStart > 0 && start > handlerStart && end > start);
  const guard = source.slice(start, end);
  for (const [protocol, byteMode, lineMode, pending, blocked] of [
    ["serial", true, false, "abc你", true],
    ["serial", true, false, "", false],
    ["serial", false, false, "abc你", false],
    ["serial", true, true, "abc你", false],
    ["ssh", true, false, "abc你", false],
  ] as const) {
    const notices: string[] = [];
    const state = {host: {protocol}, serialConfig: {byteOrientedBackspace: byteMode, lineMode}, commandBufferRef: {current: pending}, toast: {info: (text: string) => notices.push(text)}, t: (key: string) => key};
    const changed = runInNewContext(`(() => { ${guard} return true; })()`, state);
    assert.equal(changed, blocked ? undefined : true);
    assert.equal(notices.length, blocked ? 1 : 0);
  }
});

test("urgent Ctrl+C restores serial tail confidence when it clears pending input", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /clearTerminalInputStateForInterrupt\(\{[^]*?\}\);\s*lastInputWasPrintable = true;/);
});

test("pending single-line serial snippets participate in editing and local echo", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../../Terminal.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (host.protocol === 'serial' && noAutoRun");
  const end = source.indexOf("scrollToBottomAfterProgrammaticInput(data);", start);
  assert.ok(start > 0 && end > start);
  for (const [protocol, noAutoRun, isMultiLine, lineMode, localEcho, tracked] of [
    ["serial", true, false, false, true, true],
    ["serial", true, false, false, false, true],
    ["serial", false, false, false, true, false],
    ["serial", true, true, false, true, false],
    ["serial", true, false, true, true, false],
    ["ssh", true, false, false, true, false],
  ] as const) {
    const echoed: string[] = [];
    const state = {host: {protocol}, noAutoRun, isMultiLine, serialConfig: {lineMode, localEcho}, data: "你", commandBufferRef: {current: "abc"}, writeLocalTerminalData: (text: string) => echoed.push(text)};
    runInNewContext(source.slice(start, end), state);
    assert.equal(state.commandBufferRef.current, tracked ? "abc你" : "abc");
    assert.deepEqual(echoed, tracked && localEcho ? ["你"] : []);
  }
});
