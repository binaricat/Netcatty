import test from "node:test";
import assert from "node:assert/strict";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  attachSessionToTerminal,
  tryAttachSessionToTerminal,
  writeSessionData,
} from "./terminalSessionAttachment.ts";

const createFakeTerm = (activeType = "normal") => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  let cursorLine = 0;
  const term = {
    buffer: {
      active: { type: activeType },
    },
    write(data: string, callback?: () => void) {
      writes.push(data);
      for (const char of data) {
        if (char === "\n") {
          cursorLine += 1;
        }
      }
      callback?.();
    },
    registerMarker(offset: number) {
      const line = cursorLine + offset;
      markerLines.push(line);
      const marker = {
        line,
        isDisposed: false,
        dispose() {
          marker.isDisposed = true;
          disposedMarkerLines.push(line);
        },
      };
      return marker;
    },
    scrollToBottom() {},
  } as unknown as XTerm;

  return { term, writes, markerLines, disposedMarkerLines };
};

const createContext = (showLineTimestamps: boolean, host: Record<string, unknown> = {}) => ({
  host,
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

test("writeSessionData records terminal output timestamps without changing output bytes", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "hello\r\nnext");

  assert.equal(writes.join(""), "hello\r\nnext");
  assert.equal((writes.join("").match(/\[\d{2}:\d{2}:\d{2}\]/g) ?? []).length, 0);
  assert.deepEqual(markerLines, [0, 1]);
});

test("writeSessionData keeps timestamp metadata when the host gutter is disabled", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(true, { showLineTimestamps: false }) as never, term, "hello");

  assert.deepEqual(writes, ["hello"]);
  assert.deepEqual(markerLines, [0]);
});

test("writeSessionData records timestamps for hosts with timestamps enabled", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "hello");

  assert.equal(writes.join(""), "hello");
  assert.deepEqual(markerLines, [0]);
});

test("writeSessionData skips timestamps on the alternate screen", () => {
  const { term, writes, markerLines } = createFakeTerm("alternate");
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "vim screen");

  assert.deepEqual(writes, ["vim screen"]);
  assert.deepEqual(markerLines, []);
});

test("writeSessionData does not timestamp output that enters alternate screen in the same chunk", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "\x1b[?1049hvim screen");

  assert.deepEqual(writes, ["\x1b[?1049hvim screen"]);
  assert.deepEqual(markerLines, []);
});

test("writeSessionData resumes timestamps after leaving alternate screen in the same chunk", () => {
  const { term, writes, markerLines } = createFakeTerm("alternate");
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "\x1b[?1049lprompt");

  assert.equal(writes.join(""), "\x1b[?1049lprompt");
  assert.deepEqual(markerLines, [0]);
});

test("writeSessionData preserves timestamps across host gutter visibility changes", () => {
  const { term, writes, markerLines, disposedMarkerLines } = createFakeTerm();
  const ctx = createContext(false, { showLineTimestamps: false });

  writeSessionData(ctx as never, term, "before\r\n");
  ctx.host = { showLineTimestamps: true };
  writeSessionData(ctx as never, term, "enabled\r\n");
  ctx.host = { showLineTimestamps: false };
  writeSessionData(ctx as never, term, "disabled");

  assert.equal(writes.join(""), "before\r\nenabled\r\ndisabled");
  assert.deepEqual(markerLines, [0, 1, 2]);
  assert.deepEqual(disposedMarkerLines, []);
});

test("attachSessionToTerminal resets timestamp state for a reused terminal", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(false, { showLineTimestamps: true }),
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
  assert.equal(writes[1], "fresh");
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

test("tryAttachSessionToTerminal closes orphan sessions after unmount", () => {
  const { term } = createFakeTerm();
  const closed: string[] = [];
  let dataSubscribed = false;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: false },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    isBootActiveRef: { current: false },
    terminalBackend: {
      closeSession: (id: string) => {
        closed.push(id);
      },
      onSessionData: () => {
        dataSubscribed = true;
        return () => {};
      },
      onSessionExit: () => () => {},
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  const attached = tryAttachSessionToTerminal(ctx as never, term, "backend-session");

  assert.equal(attached, false);
  assert.deepEqual(closed, ["backend-session"]);
  assert.equal(dataSubscribed, false);
  assert.equal(ctx.sessionRef.current, null);
});
