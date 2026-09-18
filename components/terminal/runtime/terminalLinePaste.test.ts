import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { pasteTextWithMultilineConfirm } from "../terminalClipboardPaste";
import * as userPaste from "./terminalUserPaste";

const require = createRequire(import.meta.url);
const bridge = require("../../../electron/bridges/terminalBridge.cjs");
const source = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
// Exercise the production input handler without starting an Electron window,
// following serialInputSequences.test.ts's runtime extraction harness.
const start = source.indexOf("let lastInputWasPrintable =");
const end = source.indexOf("  let kittyCompositionPending", start);
const registrationStart = source.indexOf("  const disposeLinePasteHandler =");
const registrationEnd = source.indexOf("  term.onData(", registrationStart);
const code = ts.transpileModule(
  source.slice(start, end) + source.slice(registrationStart, registrationEnd)
    + "\nglobalThis.api = { input: handleTerminalInputData, dispose: disposeLinePasteHandler };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const helpers = await Promise.all([
  "../../../domain/serialCharMetrics.ts", "./terminalInputSanitize.ts",
  "./terminalBackspaceInput.ts", "./terminalPerCharacterInput.ts",
  "./terminalSudoAutofill.ts", "./terminalCommandExecution.ts",
  "./serialLocalEcho.ts", "../autocomplete/terminalStringCellWidth.ts",
  "./shiftEnterText.ts", "./serialLineInput.ts", "./telnetLocalEcho.ts",
].map(path => import(new URL(path, import.meta.url).href)));

for (const [protocol, lineMode, sensitive] of [
  ["serial", false, false], ["serial", false, true], ["serial", true, false], ["serial", true, true],
  ["telnet", false, false], ["telnet", false, true],
] as const) {
  test(`${protocol} confirmed line paste consumes pending text with pacing (lineMode=${lineMode}, sensitive=${sensitive})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wire: string[] = [];
    const echo: string[] = [];
    const broadcast: string[] = [];
    const writes: Array<{ data: string; sensitive?: boolean; lineDelayMs?: number }> = [];
    bridge.init({
      sessions: new Map([["serial-1", { [protocol === "serial" ? "serialPort" : "socket"]: { write: (data: string) => wire.push(String(data)) } }]]),
      electronModule: { webContents: { fromId: () => ({ send() {} }) } },
    });
    const ctx = {
      host: { protocol, id: "h", label: "h" }, sessionId: "tab-1",
      sessionRef: { current: "serial-1" }, statusRef: { current: "connected" },
      commandBufferRef: { current: "" }, serialLineBufferRef: { current: "" },
      serialLineMode: lineMode, serialLocalEcho: true, telnetLocalEchoRef: { current: true },
      passwordPromptActiveRef: { current: sensitive },
      isBroadcastEnabledRef: { current: false },
      onBroadcastInputRef: { current: () => assert.fail("paste must not broadcast twice") },
      terminalBackend: {
        writeToSession(sessionId: string, data: string, options?: { sensitive?: boolean; lineDelayMs?: number }) {
          writes.push({ data, ...options });
          bridge.writeToSession({}, { sessionId, data, ...options });
        },
      },
    };
    const term = {
      paste: () => assert.fail("paced serial input must not gain bracketed-paste markers"),
      scrollToBottom() {}, cols: 80,
      buffer: { active: { cursorX: 0, cursorY: 0, baseY: 0, getLine: () => undefined } },
    };
    const env = {
      ...Object.assign({}, ...helpers), ...userPaste, ctx, term,
      suppressNextTerminalDataBroadcast: false, handlingKittyBroadcast: false,
      prioritizeTerminalInput() {}, getFlowControllerForTerm: () => null,
      scrollToBottomAfterInput() {}, writeLocalTerminalData: (data: string) => echo.push(data),
      api: undefined as unknown as { input: (data: string) => void; dispose: () => void },
    };
    vm.runInNewContext(code, env);
    t.after(() => env.api.dispose());
    env.api.input("show ");
    ctx.isBroadcastEnabledRef.current = true;
    await pasteTextWithMultilineConfirm("version\nshow clock", {
      term, sessionId: "serial-1", terminalBackend: ctx.terminalBackend,
      getCurrentSessionId: () => ctx.sessionRef.current,
      isSensitiveInput: () => ctx.passwordPromptActiveRef.current,
      confirmMultilinePaste: {
        enabled: true, minLines: 2,
        requestConfirm: async () => {
          ctx.passwordPromptActiveRef.current = false;
          return { action: "line-by-line" };
        },
      },
      onPasteData: data => { broadcast.push(data); return true; },
    });
    assert.deepEqual(wire, lineMode ? ["show version\r"] : ["show ", "version\r"]);
    assert.equal(ctx.serialLineBufferRef.current, "");
    assert.equal(ctx.commandBufferRef.current, "");
    assert.equal(echo.join(""), "show version\r\nshow clock\r\n");
    assert.equal(writes.length, lineMode ? 1 : 2);
    assert.equal(writes.at(-1)?.lineDelayMs, 250);
    assert.equal(writes.at(-1)?.sensitive, sensitive);
    assert.deepEqual(broadcast, sensitive ? [] : ["version\nshow clock\r"]);
    t.mock.timers.tick(249);
    assert.deepEqual(wire, lineMode ? ["show version\r"] : ["show ", "version\r"]);
    t.mock.timers.tick(1);
    assert.deepEqual(wire, lineMode ? ["show version\r", "show clock\r"] : ["show ", "version\r", "show clock\r"]);
    ctx.isBroadcastEnabledRef.current = false;
    env.api.input("\r");
    assert.deepEqual(wire, lineMode ? ["show version\r", "show clock\r", "\r"] : ["show ", "version\r", "show clock\r", "\r"]);
    env.api.dispose();
    assert.equal(userPaste.dispatchTerminalLinePaste(term, "unused\r", { lineDelayMs: 250, sensitive: false }), false);
  });
}
