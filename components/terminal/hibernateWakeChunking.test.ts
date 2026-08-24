import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import xterm from "@xterm/xterm";
import serializeMod from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  applyHibernateWakeToTerminal,
  resolveHibernateWakeHistory,
} from "./terminalHibernateRuntime.ts";
import { writeTerminalPayloadChunked } from "./terminalReplay.ts";

const { Terminal } = xterm;
const { SerializeAddon } = serializeMod;

const readActiveBufferText = (term: XTerm): string => {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
};

const writeAndWait = (term: XTerm, data: string): Promise<void> =>
  new Promise((resolve) => {
    term.write(data, () => resolve());
  });

test("hibernate wake pauses flow before replay and resumes only after reattach", () => {
  // #2762 / Codex: full-history wake must not race the capped pending buffer or
  // the 64 KiB preload backlog. Pause+wait drains into pending, then stop the
  // data listener, take pending once, replay, reattach, and only then resume.
  const mountSource = readFileSync(new URL("./terminalRuntimeMount.ts", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");

  assert.match(mountSource, /prepareWakeFlow\?:\s*\(\) => Promise<boolean>/);
  assert.match(mountSource, /restoreAfterFailedWake\?:\s*\(takenPending: string\) => void/);
  assert.match(mountSource, /resumeAfterReattach\?:\s*\(\) => void/);
  assert.match(mountSource, /takePendingBuffer: \(\) => string/);
  assert.match(mountSource, /stopHibernateDataListener: \(\) => void/);
  assert.match(mountSource, /const drainOk = \(await prepareWakeFlow\?\.\(\)\) \?\? true;/);
  assert.match(mountSource, /const takeAndTrackPending = \(\): string =>/);
  assert.match(mountSource, /const pendingAtApplyStart = takeAndTrackPending\(\);/);
  assert.match(mountSource, /const pendingTail = takeAndTrackPending\(\);/);
  assert.match(mountSource, /if \(!pendingTail\) break;/);
  assert.match(mountSource, /restoreAfterFailedWake\?\.\(takenPendingForRestore\)/);
  assert.doesNotMatch(mountSource, /pending\.slice\(replayedPendingLength\)/);
  assert.doesNotMatch(mountSource, /for \(let drainPass = 0;/);
  assert.doesNotMatch(mountSource, /finalPendingDelta/);
  assert.doesNotMatch(mountSource, /preTeardownTail/);

  const prepareIndex = mountSource.indexOf("const drainOk = (await prepareWakeFlow?.()) ?? true;");
  const disableCapIndex = mountSource.indexOf("setHibernatePendingCapDisabled?.(true);");
  const stopDataBeforeReplay = mountSource.indexOf("if (drainOk) {\n      stopHibernateDataListener();");
  const pendingIndex = mountSource.indexOf("const pendingAtApplyStart = takeAndTrackPending();");
  const applyIndex = mountSource.indexOf("await applyHibernateWakeToTerminal(");
  const stopDataBeforeTail = mountSource.indexOf(
    "stopHibernateDataListener();",
    applyIndex,
  );
  const pendingTailIndex = mountSource.indexOf("const pendingTail = takeAndTrackPending();");
  const emptyBreakIndex = mountSource.indexOf("if (!pendingTail) break;");
  const shouldReattachIndex = mountSource.indexOf(
    "const shouldReattach = sessionConnected && (getSessionConnected?.() ?? true);",
  );
  const stopAllIndex = mountSource.indexOf("stopHibernateListeners();", shouldReattachIndex);
  const reattachIndex = mountSource.indexOf("reattachSession(term);", shouldReattachIndex);
  const failedRestoreIndex = mountSource.indexOf("restoreAfterFailedWake?.(takenPendingForRestore);");
  const resumeIndex = mountSource.indexOf("resumeAfterReattach?.();");

  assert.ok(prepareIndex >= 0, "wake must pause backend flow before history replay");
  assert.ok(
    disableCapIndex > prepareIndex,
    "drain failure must disable the pending cap before keeping the live listener",
  );
  assert.ok(stopDataBeforeReplay > prepareIndex, "successful drain stops the data listener before replay");
  assert.ok(pendingIndex > stopDataBeforeReplay, "pending take must run after drain handling");
  assert.ok(applyIndex > pendingIndex, "history replay follows the pending capture");
  assert.ok(
    stopDataBeforeTail > applyIndex,
    "data listener must stop again before residual pending drain",
  );
  assert.ok(
    pendingTailIndex > stopDataBeforeTail,
    "residual pending drain must run after history replay",
  );
  assert.ok(
    emptyBreakIndex > pendingTailIndex,
    "residual drain must end with an empty take before teardown",
  );
  assert.ok(
    shouldReattachIndex > emptyBreakIndex,
    "reattach decision must run after until-empty pending drain",
  );
  assert.ok(
    stopAllIndex > shouldReattachIndex,
    "full hibernate listener teardown must wait until after the reattach decision",
  );
  assert.ok(reattachIndex > stopAllIndex, "reattach runs after hibernate listeners are cleared");
  assert.ok(failedRestoreIndex >= 0, "failed wakes must restore take-and-cleared pending");
  assert.ok(resumeIndex > reattachIndex, "flow resume must wait until after reattach");
  assert.match(
    mountSource,
    /if \(!wakeSucceeded\) \{[\s\S]*?restoreAfterFailedWake\?\.\(takenPendingForRestore\);[\s\S]*?\} else if \(didReattach\) \{[\s\S]*?resumeAfterReattach\?\.\(\);/,
  );

  assert.match(
    terminalSource,
    /takePendingBuffer:\s*\(\)\s*=>\s*\{\s*const pending = hibernatePendingBufferRef\.current \+ oscNotificationScannerRef\.current\.flush\(\);\s*hibernatePendingBufferRef\.current = "";\s*return pending;\s*\}/,
  );
  assert.match(
    terminalSource,
    /setSessionFlowPausedAndWait\(backendId,\s*true\)/,
  );
  // Reconnect wakes (sessionConnected=false) must still pause when a backend
  // session exists; otherwise stopping the hibernate listener drops live output.
  assert.doesNotMatch(
    terminalSource,
    /prepareWakeFlow: async \(\) => \{\s*if \(!options\.sessionConnected\) return true;/,
  );
  assert.match(
    terminalSource,
    /stopHibernateListeners\(\{\s*keepPaused:\s*true\s*\}\)/,
  );
  assert.match(
    terminalSource,
    /restoreAfterFailedWake:\s*\(takenPending\)\s*=>\s*\{[\s\S]*?disposeRuntimeOnly\(\);[\s\S]*?beginHibernatedSessionListeners\(backendId\)/,
  );
  assert.match(
    terminalSource,
    /appendHibernatePendingBuffer\(\s*takenPending \|\| "",\s*pendingStillInRef,\s*\)/,
  );
  assert.match(
    terminalSource,
    /resumeAfterReattach:\s*\(\)\s*=>\s*\{[\s\S]*?setSessionFlowPaused\?\.\(backendId,\s*false\)/,
  );
  assert.match(
    terminalSource,
    /hibernatePendingCapDisabledRef\.current\s*\?\s*hibernatePendingBufferRef\.current \+ scanned\.remainder/,
  );
  assert.match(
    terminalSource,
    /result\?\.success === true/,
  );
});

test("writeTerminalPayloadChunked splits large buffers (shipped wake helper)", async () => {
  const writes: string[] = [];
  const term = {
    write: (data: string, cb: () => void) => {
      writes.push(data);
      cb();
    },
  } as unknown as XTerm;

  const payload = "y".repeat(50_000);
  await writeTerminalPayloadChunked(term, payload, { chunkBytes: 8_192 });
  assert.ok(writes.length >= 2, `expected multiple chunks, got ${writes.length}`);
  assert.equal(writes.join(""), payload);
});

test("resolveHibernateWakeHistory prefers the coherent full snapshot", () => {
  assert.equal(
    resolveHibernateWakeHistory({
      snapshot: "FULL",
      viewportSnapshot: "VIEW",
      scrollbackSnapshot: "SCROLL",
      pendingBuffer: "",
      alternateScreen: false,
    }),
    "FULL",
  );
});

test("resolveHibernateWakeHistory falls back to scrollback before viewport with a seam newline", () => {
  assert.equal(
    resolveHibernateWakeHistory({
      snapshot: "",
      viewportSnapshot: "VIEWPORT_END\r\n",
      scrollbackSnapshot: "SCROLLBACK_START",
      pendingBuffer: "",
      alternateScreen: false,
    }),
    "SCROLLBACK_START\r\nVIEWPORT_END\r\n",
  );
  assert.equal(
    resolveHibernateWakeHistory({
      snapshot: "",
      viewportSnapshot: "VIEWPORT_END\r\n",
      scrollbackSnapshot: "SCROLLBACK_START\r\n",
      pendingBuffer: "",
      alternateScreen: false,
    }),
    "SCROLLBACK_START\r\nVIEWPORT_END\r\n",
  );
});

test("applyHibernateWakeToTerminal replays snapshot then pending without idle append", async () => {
  const writes: string[] = [];
  const term = {
    rows: 24,
    write: (data: string, cb?: () => void) => {
      writes.push(data);
      cb?.();
    },
    refresh: () => {},
  } as unknown as XTerm;

  const runtime = {
    ensureWebglRenderer: () => {},
    clearTextureAtlas: () => {},
  };

  let idleScheduled = false;
  const originalRic = globalThis.requestIdleCallback;
  // @ts-expect-error test override
  globalThis.requestIdleCallback = (cb: () => void) => {
    idleScheduled = true;
    setTimeout(cb, 0);
    return 1;
  };

  try {
    const snapshot = "SCROLLBACK_START\r\nVIEWPORT_END\r\n";
    const pending = "PENDING_TAIL\r\n";
    await applyHibernateWakeToTerminal(
      term,
      runtime as never,
      {
        snapshot,
        viewportSnapshot: "VIEWPORT_END\r\n",
        scrollbackSnapshot: "SCROLLBACK_START\r\n",
        pendingBuffer: pending,
        alternateScreen: false,
      },
      { replayOptions: { chunkBytes: 8_192 } },
    );

    assert.equal(writes.join(""), `${snapshot}${pending}`);
    assert.equal(
      idleScheduled,
      false,
      "scrollback must not be deferred to idle after viewport (append would evict the end)",
    );
  } finally {
    if (originalRic) {
      globalThis.requestIdleCallback = originalRic;
    } else {
      // @ts-expect-error cleanup
      delete globalThis.requestIdleCallback;
    }
  }
});

test("hibernate wake keeps newest rows from a SerializeAddon snapshot under a finite scrollback cap", async () => {
  // #2762: idle-appending older scrollback after viewport under scrollback=N
  // evicts the newest rows. Prefer the full SerializeAddon snapshot.
  const rows = 5;
  const scrollbackCap = 8;
  const source = new Terminal({
    cols: 40,
    rows,
    scrollback: 50,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  source.loadAddon(serializeAddon);

  const olderLines = Array.from({ length: 20 }, (_, index) => `old-${index}`);
  const newestLines = Array.from({ length: rows }, (_, index) => `new-${index}`);
  await writeAndWait(source, `${olderLines.join("\r\n")}\r\n${newestLines.join("\r\n")}\r\n`);

  const snapshot = serializeAddon.serialize();
  const bufferLength = source.buffer.active.length;
  const viewportStart = Math.max(0, bufferLength - rows);
  const scrollbackSnapshot = serializeAddon.serialize({
    range: { start: Math.max(0, viewportStart - 20), end: viewportStart - 1 },
  });
  const viewportSnapshot = serializeAddon.serialize({
    range: { start: viewportStart, end: bufferLength - 1 },
  });
  source.dispose();

  // Range concat is not byte-identical to the full snapshot (missing seam newline).
  assert.notEqual(scrollbackSnapshot + viewportSnapshot, snapshot);

  const term = new Terminal({
    cols: 40,
    rows,
    scrollback: scrollbackCap,
    allowProposedApi: true,
  });
  const runtime = {
    ensureWebglRenderer: () => {},
    clearTextureAtlas: () => {},
  };

  try {
    await applyHibernateWakeToTerminal(
      term,
      runtime as never,
      {
        snapshot,
        viewportSnapshot,
        scrollbackSnapshot,
        pendingBuffer: "",
        alternateScreen: false,
      },
      { replayOptions: { chunkBytes: 1024 } },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    const text = readActiveBufferText(term);
    for (const line of newestLines) {
      assert.match(text, new RegExp(line), `newest viewport line missing after wake: ${line}`);
    }
    assert.doesNotMatch(text, /new-0new-1/, "seam must not merge adjacent snapshot lines");
  } finally {
    term.dispose();
  }
});

test("wrong wake order (viewport then scrollback append) drops newest rows under scrollback cap", async () => {
  // Guardrail: documents why idle-append-after-viewport is unsafe.
  const rows = 5;
  const scrollbackCap = 10;
  const term = new Terminal({
    cols: 40,
    rows,
    scrollback: scrollbackCap,
    allowProposedApi: true,
  });

  try {
    const olderLines = Array.from({ length: scrollbackCap + rows }, (_, index) => `old-${index}`);
    const newestLines = Array.from({ length: rows }, (_, index) => `new-${index}`);
    await writeAndWait(term, `${newestLines.join("\r\n")}\r\n`);
    await writeAndWait(term, `${olderLines.join("\r\n")}\r\n`);

    const text = readActiveBufferText(term);
    for (const line of newestLines) {
      assert.equal(
        text.includes(line),
        false,
        `viewport-first append must evict newest line under the cap: ${line}`,
      );
    }
    assert.match(text, /old-14/);
  } finally {
    term.dispose();
  }
});

test("hibernate runtime source prefers resolveHibernateWakeHistory on the wake path", () => {
  const source = readFileSync(new URL("./terminalHibernateRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /export function resolveHibernateWakeHistory/);
  assert.match(
    source,
    /writeTerminalReplaySequence\(\s*term,\s*\[\s*history,\s*payload\.pendingBuffer\s*\]/,
  );
  assert.doesNotMatch(
    source,
    /scheduleIdle\(\(\)\s*=>\s*\{\s*void writeTerminalPayloadChunked\(term, scrollback/,
  );
});
