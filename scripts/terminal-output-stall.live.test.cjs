const assert = require("node:assert/strict");
const test = require("node:test");

const { Terminal } = require("@xterm/xterm");
const { Client } = require("ssh2");

const {
  getFlowController,
  writeSessionData,
} = require("../components/terminal/runtime/terminalSessionAttachment.ts");
const {
  clearTerminalSessionFlowAck,
  flushTerminalSessionFlowAck,
} = require("../components/terminal/runtime/terminalFlowAckBuffer.ts");
const {
  flushPendingTerminalWritesBeforeHibernate,
  hasPendingTerminalWrites,
} = require("../components/terminal/runtime/terminalUnfocusedRepaint.ts");

const COLS = 266;
const ROWS = 68;
const DEFAULT_STRESS_MS = 12_000;
const MIN_EXPECTED_BYTES = 8 * 1024 * 1024;

const parseTargets = () => {
  if (!process.env.NETCATTY_TERMINAL_STRESS_TARGETS) return [];
  const parsed = JSON.parse(process.env.NETCATTY_TERMINAL_STRESS_TARGETS);
  if (!Array.isArray(parsed)) {
    throw new TypeError("NETCATTY_TERMINAL_STRESS_TARGETS must be a JSON array");
  }
  return parsed;
};

const createContext = (sessionId, onAck, onPause) => {
  const host = { showLineTimestamps: false };
  return {
    host,
    hostRef: { current: host },
    terminalSettingsRef: {
      current: {
        showLineTimestamps: false,
        scrollOnOutput: false,
        forcePromptNewLine: false,
      },
    },
    terminalSettings: {
      showLineTimestamps: false,
      scrollOnOutput: false,
      forcePromptNewLine: false,
    },
    terminalBackend: {
      ackSessionFlow: onAck,
      setSessionFlowPaused: onPause,
    },
    sessionRef: { current: sessionId },
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: true },
    promptLineBreakStateRef: { current: undefined },
  };
};

const readTerminalText = (term) => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
};

const pythonStressSource = String.raw`
import select
import sys
import time

cols = ${COLS}
rows = ${ROWS}
frame = 0
sys.stdout.write("\x1b[?1049h\x1b[2J")
sys.stdout.flush()
try:
    while frame < 10000:
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if ready and "q" in sys.stdin.readline():
            break
        parts = ["\x1b[?2026h\x1b[H"]
        for sweep in range(9):
            color = (frame + sweep) % 216 + 16
            fill = chr(65 + ((frame + sweep) % 26)) * cols
            for row in range(1, rows + 1):
                parts.append("\x1b[%d;1H\x1b[48;5;%dm%s" % (row, color, fill))
        parts.append("\x1b[0m\x1b[?2026l")
        sys.stdout.write("".join(parts))
        sys.stdout.flush()
        frame += 1
        time.sleep(0.12)
finally:
    sys.stdout.write("\x1b[?2026l\x1b[?1049l\r\nNETCATTY_STRESS_DONE frames=%d\r\n" % frame)
    sys.stdout.flush()
`;

const buildRemoteCommand = () => {
  const encoded = Buffer.from(pythonStressSource, "utf8").toString("base64");
  return `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
};

const installSuppressedRendererWakeups = () => {
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalSetTimeout = globalThis.setTimeout;
  const suppressedTimers = new Set();
  let nextFrameId = 1;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => {
      const id = nextFrameId;
      nextFrameId += 1;
      return id;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  });
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 24) {
      return originalSetTimeout(callback, delay, ...args);
    }
    // Reproduce the second lost-wakeup edge from #2467: the visible idle
    // safety timer never runs. The independent coalescer deadline must still
    // carry output into xterm.
    const timer = originalSetTimeout(() => {}, 2_147_483_647);
    timer.unref?.();
    suppressedTimers.add(timer);
    return timer;
  };
  return () => {
    globalThis.setTimeout = originalSetTimeout;
    for (const timer of suppressedTimers) {
      clearTimeout(timer);
    }
    if (requestDescriptor) {
      Object.defineProperty(globalThis, "requestAnimationFrame", requestDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (cancelDescriptor) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", cancelDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  };
};

const connect = (target) => new Promise((resolve, reject) => {
  const connection = new Client();
  connection.once("ready", () => resolve(connection));
  connection.once("error", reject);
  connection.connect({
    host: target.host,
    port: target.port ?? 22,
    username: target.username,
    password: target.password,
    readyTimeout: 10_000,
  });
});

const execStress = (connection) => new Promise((resolve, reject) => {
  connection.exec(
    buildRemoteCommand(),
    { pty: { term: "xterm-256color", cols: COLS, rows: ROWS } },
    (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    },
  );
});

const waitForClose = (stream, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("remote TUI did not exit after input")), timeoutMs);
  stream.once("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const runRemoteStress = async (target) => {
  const sessionId = `live-stress-${target.host}`;
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 2_000,
    allowProposedApi: true,
  });
  let connection;
  let stream;
  let ingressBytes = 0;
  let ackedBytes = 0;
  let chunkCount = 0;
  let paused = false;
  let pauseCount = 0;
  let maxPendingBytes = 0;
  let stderr = "";
  let resolveFirstChunk;
  const firstChunk = new Promise((resolve) => {
    resolveFirstChunk = resolve;
  });
  let probingLostWakeup = true;
  const ctx = createContext(
    sessionId,
    (_id, bytes) => {
      ackedBytes += bytes;
    },
    (_id, nextPaused) => {
      paused = nextPaused;
      if (nextPaused) {
        pauseCount += 1;
        stream?.pause();
      } else {
        stream?.resume();
      }
    },
  );

  clearTerminalSessionFlowAck(sessionId);
  const restoreWakeups = installSuppressedRendererWakeups();
  const startedAt = performance.now();
  try {
    connection = await connect(target);
    stream = await execStress(connection);
    stream.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    stream.on("data", (chunk) => {
      const data = chunk.toString("utf8");
      ingressBytes += chunk.length;
      chunkCount += 1;
      writeSessionData(ctx, term, data, chunk.length);
      maxPendingBytes = Math.max(
        maxPendingBytes,
        getFlowController(ctx, term).pendingBytes(),
      );
      if (probingLostWakeup) {
        probingLostWakeup = false;
        // Freeze ingress after one under-cap chunk, then close the frame gate.
        // No later push is allowed to rescue this batch.
        stream.pause();
        ctx.isPaneVisibleRef.current = false;
        resolveFirstChunk();
      }
    });

    await firstChunk;
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctx.isPaneVisibleRef.current = true;
    await waitFor(
      () => ackedBytes > 0,
      1_000,
      "first terminal batch was stranded after the visibility gate changed",
    );
    stream.resume();

    await new Promise((resolve) => setTimeout(resolve, target.stressMs ?? DEFAULT_STRESS_MS));
    const inputSentAt = performance.now();
    stream.write("q\n");
    const closed = await waitForClose(stream, 15_000);
    const inputLatencyMs = performance.now() - inputSentAt;
    const drained = await flushPendingTerminalWritesBeforeHibernate(term);
    flushTerminalSessionFlowAck(sessionId);
    const controllerPendingBytes = getFlowController(ctx, term).pendingBytes();
    const terminalText = readTerminalText(term);
    const result = {
      host: target.host,
      durationMs: Math.round(performance.now() - startedAt),
      inputLatencyMs: Math.round(inputLatencyMs),
      ingressBytes,
      ackedBytes,
      chunkCount,
      pauseCount,
      maxPendingBytes,
      controllerPendingBytes,
      pipelinePending: hasPendingTerminalWrites(term),
      exitCode: closed.code,
      signal: closed.signal,
      markerSeen: terminalText.includes("NETCATTY_STRESS_DONE"),
    };

    assert.equal(stderr, "", `remote stderr: ${stderr}`);
    assert.equal(closed.code, 0);
    assert.equal(drained, true);
    assert.equal(result.pipelinePending, false);
    assert.equal(controllerPendingBytes, 0);
    assert.equal(paused, false);
    assert.equal(ackedBytes, ingressBytes);
    assert.equal(result.markerSeen, true);
    assert.ok(ingressBytes >= (target.minBytes ?? MIN_EXPECTED_BYTES));
    assert.ok(inputLatencyMs < 5_000, `input took ${Math.round(inputLatencyMs)} ms`);
    return result;
  } finally {
    restoreWakeups();
    clearTerminalSessionFlowAck(sessionId);
    stream?.destroy();
    connection?.end();
    term.dispose();
  }
};

const targets = parseTargets();

test("live SSH TUI output does not strand the Netcatty terminal pipeline", {
  skip: targets.length === 0 ? "set NETCATTY_TERMINAL_STRESS_TARGETS" : false,
  timeout: Math.max(60_000, targets.length * 35_000),
}, async () => {
  const results = [];
  for (const target of targets) {
    results.push(await runRemoteStress(target));
  }
  console.log(`NETCATTY_STRESS_RESULTS=${JSON.stringify(results)}`);
});
