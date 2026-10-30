import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const start = source.indexOf("  term.onBinary((data) => {");
const end = source.indexOf("  const handleKittyKeyboardBroadcast =", start);
assert.ok(start >= 0 && end > start, "runtime must subscribe to xterm onBinary");

test("onBinary forwards unchanged bytes only to the current session without text handling", () => {
  const writes: Array<{ id: string; data: string; binary: boolean }> = [];
  const sessionRef: { current: string | null } = { current: "first" };
  let receive!: (data: string) => void;
  runInNewContext(source.slice(start, end), {
    term: { onBinary(callback: typeof receive) { receive = callback; } },
    ctx: {
      sessionRef,
      terminalBackend: {
        writeToSession(id: string, data: string, options: { binary: boolean }) {
          writes.push({ id, data, binary: options.binary });
        },
      },
    },
    handleTerminalInputData: () => assert.fail("binary reports must bypass text handling"),
  });

  const mouse = String.fromCharCode(0x1b, 0x5b, 0x4d, 0x20, 0x21, 0xc0);
  receive(mouse);
  sessionRef.current = "replacement";
  const allBytes = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));
  receive(allBytes);
  sessionRef.current = null;
  receive(mouse);

  assert.deepEqual(writes, [
    { id: "first", data: mouse, binary: true },
    { id: "replacement", data: allBytes, binary: true },
  ]);
});
