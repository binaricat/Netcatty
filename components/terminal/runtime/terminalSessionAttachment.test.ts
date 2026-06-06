import test from "node:test";
import assert from "node:assert/strict";
import type { Terminal as XTerm } from "@xterm/xterm";

import { attachSessionToTerminal, writeSessionData } from "./terminalSessionAttachment.ts";

const createFakeTerm = (activeType = "normal") => {
  const writes: string[] = [];
  const term = {
    buffer: {
      active: { type: activeType },
    },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;

  return { term, writes };
};

const createContext = (showLineTimestamps: boolean) => ({
  terminalSettingsRef: {
    current: {
      showLineTimestamps,
      scrollOnOutput: false,
      forcePromptNewLine: false,
    },
  },
  terminalSettings: {
    showLineTimestamps,
    scrollOnOutput: false,
    forcePromptNewLine: false,
  },
  terminalBackend: {},
  sessionRef: { current: "session-1" },
  promptLineBreakStateRef: { current: undefined },
});

test("writeSessionData prefixes terminal output lines when enabled", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(true) as never, term, "hello\r\nnext");

  assert.equal(writes.length, 1);
  assert.equal((writes[0].match(/\[\d{2}:\d{2}:\d{2}\]/g) ?? []).length, 2);
  assert.ok(writes[0].includes("\x1b[2;90m["));
  assert.ok(writes[0].includes("] \x1b[22;39mhello\r\n\x1b[2;90m["));
  assert.ok(writes[0].endsWith("] \x1b[22;39mnext"));
});

test("writeSessionData skips timestamps on the alternate screen", () => {
  const { term, writes } = createFakeTerm("alternate");
  writeSessionData(createContext(true) as never, term, "vim screen");

  assert.deepEqual(writes, ["vim screen"]);
});

test("writeSessionData does not timestamp output that enters alternate screen in the same chunk", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(true) as never, term, "\x1b[?1049hvim screen");

  assert.deepEqual(writes, ["\x1b[?1049hvim screen"]);
});

test("writeSessionData resumes timestamps after leaving alternate screen in the same chunk", () => {
  const { term, writes } = createFakeTerm("alternate");
  writeSessionData(createContext(true) as never, term, "\x1b[?1049lprompt");

  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith("\x1b[?1049l\x1b[2;90m["));
  assert.ok(writes[0].endsWith("] \x1b[22;39mprompt"));
});

test("attachSessionToTerminal resets timestamp state for a reused terminal", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: () => () => {},
      onSessionExit: () => () => {},
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  writeSessionData(ctx as never, term, "unfinished");
  attachSessionToTerminal(ctx as never, term, "session-2");
  writeSessionData(ctx as never, term, "fresh");

  assert.equal(writes.length, 2);
  assert.equal((writes[1].match(/\[\d{2}:\d{2}:\d{2}\]/g) ?? []).length, 1);
  assert.ok(writes[1].endsWith("] \x1b[22;39mfresh"));
});

test("attachSessionToTerminal hints for sudo password prompts and fills on confirm", () => {
  const { term, writes } = createFakeTerm();
  const sent: Array<{ id: string; data: string; automated?: boolean }> = [];
  const hints: boolean[] = [];
  let onData: ((data: string) => void) | null = null;
  const sudoAutofillRef = { current: null };
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    sudoAutofillRef,
    onSudoHint: (active: boolean) => hints.push(active),
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sent.push({ id, data, automated: options?.automated });
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1", {
    sudoAutofillPassword: "secret",
  });
  sudoAutofillRef.current?.armForCommand("sudo whoami");
  onData?.("sudo whoami\r\n");
  onData?.("[sudo] password for alice: ");

  // Confirm-to-fill model: detecting the prompt raises a hint but never sends
  // the password on its own.
  assert.deepEqual(hints, [true]);
  assert.deepEqual(sent, []);
  assert.equal(writes[0], "sudo whoami\r\n");
  assert.equal(writes[1], "[sudo] password for alice: ");

  // The password is only written once the user confirms (presses Enter).
  sudoAutofillRef.current?.confirmFill();
  assert.deepEqual(sent, [{ id: "session-1", data: "secret\n", automated: true }]);
});

test("attachSessionToTerminal does not auto-fill unarmed sudo-looking output", () => {
  const { term } = createFakeTerm();
  const sent: string[] = [];
  let onData: ((data: string) => void) | null = null;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    sudoAutofillRef: { current: null },
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: (_id: string, data: string) => {
        sent.push(data);
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1", {
    sudoAutofillPassword: "secret",
  });
  onData?.("[sudo] password for alice: ");

  assert.deepEqual(sent, []);
});

test("attachSessionToTerminal leaves sudo prompts alone without an autofill password", () => {
  const { term } = createFakeTerm();
  const sent: string[] = [];
  let onData: ((data: string) => void) | null = null;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: (_id: string, data: string) => {
        sent.push(data);
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1");
  onData?.("[sudo] password for alice: ");

  assert.deepEqual(sent, []);
});
