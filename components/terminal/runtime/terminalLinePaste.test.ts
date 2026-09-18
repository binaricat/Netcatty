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
const registrationStart = source.indexOf("  const pendingLinePastes =");
const registrationEnd = source.indexOf("  term.onData(", registrationStart);
const urgentStart = source.indexOf("        clearTerminalInputStateForInterrupt({");
const urgentEnd = source.indexOf("        const interruptEventForKitty", urgentStart);
const urgentCode = "\nconst urgent = () => { const id = ctx.sessionRef.current; const interruptTrace = undefined; "
  + source.slice(urgentStart, urgentEnd) + "\n};";
const code = ts.transpileModule(
  source.slice(start, end) + source.slice(registrationStart, registrationEnd)
    + urgentCode + "\nglobalThis.api = { urgent, input: handleTerminalInputData, dispose: () => { disposeLinePasteHandler(); disposePasteWriteReceipts?.(); pendingLinePastes.clear(); } };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const helpers = await Promise.all([
  "../../../domain/serialCharMetrics.ts", "./terminalReportSequence.ts", "./terminalInputSanitize.ts",
  "./terminalBackspaceInput.ts", "./terminalPerCharacterInput.ts",
  "./terminalSudoAutofill.ts", "./terminalCommandExecution.ts",
  "./terminalInterruptInputState.ts", "./serialLocalEcho.ts", "../autocomplete/terminalStringCellWidth.ts",
  "./shiftEnterText.ts", "./serialLineInput.ts", "./telnetLocalEcho.ts",
].map(path => import(new URL(path, import.meta.url).href)));

for (const [protocol, lineMode, sensitive] of [
  ["serial", false, false], ["serial", false, true], ["serial", true, false], ["serial", true, true],
  ["telnet", false, false], ["telnet", false, true],
  ["ssh", false, false], ["ssh", false, true], ["local", false, false],
  ["mosh", false, false], ["et", false, false], ["plugin:example", false, false],
] as const) {
  for (const completion of ["late-urgent", "filtered-first", "pending-manual", "pending-clear", "pending-ack", "blocked-first", "failed-first", "complete", "manual", "interrupt", "replacement", "password-ref", "password-screen", "output", "serial-text", "serial-backspace", "serial-clear", "serial-arrow", "serial-delete", "serial-report"] as const) {
  if (completion.startsWith("serial-") && !lineMode) continue;
  if ((completion.startsWith("pending-") || completion === "filtered-first") && sensitive) continue;
  test(`${completion}: ${protocol} confirmed line paste consumes pending text with pacing (lineMode=${lineMode}, sensitive=${sensitive})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wire: string[] = [];
    const echo: string[] = [];
    const broadcast: string[] = [];
    const submitted: string[] = [];
    const history: string[] = [];
    const recordingSensitivity: boolean[] = [];
    const loginCancellationNotices: string[] = [];
    let liveLine = protocol === "ssh" ? "alice@host:~$ show " : "";
    const autocomplete: string[] = [];
    const outputTriggers: string[] = [];
    const recorded: string[] = [];
    let recorderInput = "";
    const queuedReceipts: unknown[] = [];
    let receiptListener: ((event: unknown) => void) | undefined;
    const writes: Array<{ data: string; sensitive?: boolean; lineDelayMs?: number; automated?: boolean }> = [];
    let rejectPaste = false;
    let releaseFirst: (() => void) | undefined;
    const session = { zmodemSentry: { isActive: () => rejectPaste && completion === "blocked-first" }, [protocol === "serial" ? "serialPort" : protocol === "telnet" ? "socket" : protocol === "local" ? "proc" : "stream"]: { write: (data: string) => {
        if (rejectPaste && completion === "failed-first") throw new Error("write failed");
        wire.push(String(data));
      } } };
    bridge.init({
      sessions: new Map([["serial-1", session]]),
      terminalDataPipeline: completion.startsWith("pending-") || completion === "filtered-first" ? {
        has: () => true,
        interceptInput(_id: string, data: string) {
          if (completion === "filtered-first") return data.includes("version") ? "" : data;
          if (rejectPaste && !releaseFirst) return new Promise<string>(resolve => { releaseFirst = () => resolve(data); });
          return data;
        },
      } : undefined,
      electronModule: { webContents: { fromId: () => ({ send(channel: string, event: unknown) { if (channel === "netcatty:paste-write") {
        if (completion === "late-urgent") queuedReceipts.push(event);
        else receiptListener?.(event);
      } } }) } },
    });
    const ctx = {
      host: { protocol, id: "h", label: "h" }, sessionId: "tab-1",
      sessionRef: { current: "serial-1" }, statusRef: { current: "connected" },
      commandBufferRef: { current: "" }, serialLineBufferRef: { current: "" },
      serialLineMode: lineMode, serialLocalEcho: true, telnetLocalEchoRef: { current: true },
      passwordPromptActiveRef: { current: sensitive },
      onCommandSubmitted: (command: string) => submitted.push(command),
      onCommandExecuted: (command: string) => history.push(command),
      onAutocompleteInput: (data: string) => autocomplete.push(data),
      onOutputTriggerUserInputRef: { current: (data: string) => outputTriggers.push(data) },
      scriptRecorderRef: { current: { isRecording: true,
        recordClearLine: () => { recorderInput = ""; },
        recordBackspace: () => { recorderInput = recorderInput.slice(0, -1); },
        recordInput: (data: string) => { recorderInput += data; },
        recordEnter: async ({ sensitive: secret }: { sensitive: boolean }) => {
          if (!secret) recorded.push(recorderInput);
          recorderInput = "";
        },
        captureSubmittedLineRecorder: () => {
          const pendingInput = recorderInput;
          recorderInput = "";
          return async (line: string, { sensitive: secret, includePendingInput }: { sensitive: boolean; includePendingInput?: boolean }) => {
            recordingSensitivity.push(secret);
            if (!secret) recorded.push(includePendingInput ? pendingInput + line : line);
          };
        },
      } },
      isBroadcastEnabledRef: { current: false },
      onBroadcastInputRef: { current: () => assert.fail("paste must not broadcast twice") },
      terminalBackend: {
        notifyUserInput(sessionId: string) { loginCancellationNotices.push(sessionId); },
        interruptSession(sessionId: string, _trace: unknown, options?: { cancelPendingWritesOnly?: boolean }) {
          bridge.interruptSession({}, { sessionId, ...options });
        },
        writeToSession(sessionId: string, data: string, options?: { sensitive?: boolean; lineDelayMs?: number }) {
          writes.push({ data, ...options });
          bridge.writeToSession({}, { sessionId, data, ...options });
        },
      },
    };
    const term = {
      paste: () => assert.fail("paced serial input must not gain bracketed-paste markers"),
      scrollToBottom() {}, cols: 80,
      buffer: { active: { cursorX: 18, cursorY: 0, baseY: 0, getLine: (row: number) => liveLine && row === 0
        ? { isWrapped: false, translateToString: () => liveLine } : undefined } },
    };
    const env = {
      ...Object.assign({}, ...helpers), ...userPaste, ctx, term, crypto, isPluginHostProtocol: () => false, logger: { warn() {} },
      netcattyBridge: { get: () => ({ onTerminalPasteWrite: (listener: typeof receiptListener) => { receiptListener = listener; return () => { receiptListener = undefined; }; } }) },
      suppressNextTerminalDataBroadcast: false, handlingKittyBroadcast: false,
      prioritizeTerminalInput() {}, getFlowControllerForTerm: () => null,
      scrollToBottomAfterInput() {}, writeLocalTerminalData: (data: string) => echo.push(data),
      api: undefined as unknown as { urgent: () => void; input: (data: string) => void; dispose: () => void },
    };
    vm.runInNewContext(code, env);
    t.after(() => env.api.dispose());
    env.api.input("show ");
    ctx.isBroadcastEnabledRef.current = true;
    rejectPaste = true;
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
    if (completion === "late-urgent") {
      ctx.isBroadcastEnabledRef.current = false;
      env.api.urgent();
      env.api.input("show new draft");
      for (const receipt of queuedReceipts.splice(0)) receiptListener?.(receipt);
      assert.equal(ctx.commandBufferRef.current, "show new draft");
      if (lineMode) assert.equal(ctx.serialLineBufferRef.current, "show new draft");
      env.api.input("\r");
      if (lineMode) assert.equal(wire.at(-1), "show new draft\r");
      return;
    }
    if (completion === "filtered-first") {
      t.mock.timers.tick(250);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(wire, lineMode ? ["show clock\r"] : ["show ", "show clock\r"]);
      assert.equal(ctx.commandBufferRef.current, "show ");
      if (lineMode) assert.equal(ctx.serialLineBufferRef.current, "show ");
      assert.deepEqual(history, ["show clock"]);
      return;
    }
    if (completion.startsWith("pending-")) {
      assert.equal(ctx.commandBufferRef.current, "show ");
      assert.deepEqual(history, []);
      ctx.isBroadcastEnabledRef.current = false;
      if (completion === "pending-manual") env.api.input("x");
      if (completion === "pending-clear") {
        env.api.input("\x15");
        env.api.input("show new draft");
      }
      releaseFirst?.();
      await new Promise(resolve => setImmediate(resolve));
      if (completion === "pending-ack") {
        assert.equal(ctx.commandBufferRef.current, "");
        assert.deepEqual(history, sensitive ? [] : ["show version"]);
        if (lineMode) assert.equal(ctx.serialLineBufferRef.current, "");
      } else {
        assert.equal(ctx.commandBufferRef.current, completion === "pending-manual" ? "show x" : "show new draft");
        assert.deepEqual(history, []);
      }
      bridge.interruptSession({}, { sessionId: "serial-1", cancelPendingWritesOnly: true });
      t.mock.timers.tick(1000);
      return;
    }
    if (completion === "blocked-first" || completion === "failed-first") {
      t.mock.timers.tick(1000);
      assert.deepEqual(wire, lineMode ? [] : ["show "]);
      assert.equal(ctx.commandBufferRef.current, "show ");
      if (lineMode) assert.equal(ctx.serialLineBufferRef.current, "show ");
      assert.deepEqual(history, []);
      assert.deepEqual(recorded, []);
      rejectPaste = false;
      ctx.isBroadcastEnabledRef.current = false;
      env.api.input("next");
      assert.equal(ctx.commandBufferRef.current, "show next");
      env.api.input("\r");
      if (lineMode) assert.equal(wire.at(-1), "show next\r");
      return;
    }
    assert.deepEqual(wire, lineMode ? ["show version\r"] : ["show ", "version\r"]);
    assert.equal(ctx.serialLineBufferRef.current, "");
    assert.deepEqual(loginCancellationNotices, lineMode ? ["serial-1", "serial-1"] : []);
    assert.equal(ctx.commandBufferRef.current, "");
    assert.deepEqual(submitted, sensitive ? [] : ["show version"]);
    assert.deepEqual(recorded, sensitive ? [] : ["show version"]);
    assert.deepEqual(autocomplete, ["show ", "version\nshow clock\r"]);
    assert.ok(outputTriggers.join("").includes("show clock"));
    assert.equal(echo.join(""), protocol === "serial" || protocol === "telnet" ? "show version\r\nshow clock\r\n" : "");
    assert.equal(writes.length, lineMode ? 1 : 2);
    assert.equal(writes.at(-1)?.lineDelayMs, 250);
    assert.equal(writes.at(-1)?.automated, false, "confirmed paced paste is still user input");
    assert.equal(writes.at(-1)?.sensitive, sensitive);
    assert.deepEqual(broadcast, sensitive ? [] : ["version\nshow clock\r"]);
    t.mock.timers.tick(249);
    assert.deepEqual(wire, lineMode ? ["show version\r"] : ["show ", "version\r"]);
    if (completion === "replacement") {
      await pasteTextWithMultilineConfirm("replacement", {
        term, sessionId: "serial-1", terminalBackend: ctx.terminalBackend,
        getCurrentSessionId: () => ctx.sessionRef.current,
        isSensitiveInput: () => sensitive,
        confirmMultilinePaste: { enabled: true, minLines: 1, requestConfirm: async () => ({ action: "line-by-line" }) },
      });
      const afterReplacement = [...wire];
      assert.equal(wire.at(-1), "replacement\r");
      t.mock.timers.tick(1000);
      assert.deepEqual(wire, afterReplacement);
      assert.deepEqual(submitted, sensitive ? [] : ["show version", "replacement"]);
      assert.deepEqual(recorded, sensitive ? [] : ["show version", "replacement"]);
      return;
    }
    if (completion === "password-ref" || completion === "password-screen" || completion === "output") {
      liveLine = completion === "password-screen" ? "Password: " : "working... still producing output";
      ctx.passwordPromptActiveRef.current = completion === "password-ref";
      t.mock.timers.tick(1);
      assert.equal(wire.at(-1), "show clock\r");
      const secondSensitive = sensitive || completion !== "output";
      assert.deepEqual(recordingSensitivity, [sensitive, secondSensitive]);
      assert.deepEqual(history, sensitive ? [] : secondSensitive ? ["show version"] : ["show version", "show clock"]);
      assert.deepEqual(recorded, sensitive ? [] : secondSensitive ? ["show version"] : ["show version", "show clock"]);
      return;
    }
    if (completion.startsWith("serial-")) {
      ctx.isBroadcastEnabledRef.current = false;
      const beforeEdit = [...wire];
      const edit = completion === "serial-text" ? "x" : completion === "serial-backspace" ? "\x7f"
        : completion === "serial-arrow" ? "\x1b[D" : completion === "serial-delete" ? "\x1b[3~"
          : completion === "serial-report" ? "\x1b[1;2R" : "\x15";
      env.api.input(edit);
      t.mock.timers.tick(1000);
      if (completion === "serial-report") {
        assert.deepEqual(wire, [...beforeEdit, "show clock\r"]);
        return;
      }
      assert.deepEqual(wire, beforeEdit);
      assert.equal(ctx.serialLineBufferRef.current, completion === "serial-backspace" || completion === "serial-clear" ? "" : edit);
      assert.deepEqual(submitted, sensitive ? [] : ["show version"]);
      assert.deepEqual(recorded, sensitive ? [] : ["show version"]);
      return;
    }
    if (completion !== "complete") {
      ctx.isBroadcastEnabledRef.current = false;
      if (completion === "manual") env.api.input(lineMode ? "\x03" : "x");
      else bridge.interruptSession({}, { sessionId: "serial-1" });
      const afterCancellation = [...wire];
      t.mock.timers.tick(1000);
      assert.deepEqual(wire, afterCancellation);
      assert.deepEqual(submitted, sensitive ? [] : ["show version"]);
      assert.deepEqual(recorded, sensitive ? [] : ["show version"]);
      return;
    }
    t.mock.timers.tick(1);
    assert.deepEqual(wire, lineMode ? ["show version\r", "show clock\r"] : ["show ", "version\r", "show clock\r"]);
    assert.deepEqual(submitted, sensitive ? [] : ["show version", "show clock"]);
    assert.deepEqual(recorded, sensitive ? [] : ["show version", "show clock"]);
    ctx.isBroadcastEnabledRef.current = false;
    env.api.input("\r");
    assert.deepEqual(wire, lineMode ? ["show version\r", "show clock\r", "\r"] : ["show ", "version\r", "show clock\r", "\r"]);
    env.api.dispose();
    assert.equal(userPaste.dispatchTerminalLinePaste(term, "unused\r", { lineDelayMs: 250, sensitive: false }), false);
  });
  }
}
