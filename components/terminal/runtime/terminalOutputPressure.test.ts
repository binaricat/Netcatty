import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  getTerminalOutputPressure,
  isTerminalScrollbackSaturated,
  noteTerminalOutputPressureData,
  resetTerminalOutputPressure,
  setTerminalOutputPressureVisibility,
  shouldDegradeTerminalSideWork,
  shouldSkipTerminalLineTimestamps,
} from "./terminalOutputPressure.ts";
import { TERMINAL_LONG_LINE_PRESSURE_BYTES } from "./terminalFlowConstants.ts";
import { XTERM_PERFORMANCE_CONFIG } from "../../../infrastructure/config/xtermPerformance.ts";

const createFakeTerm = (overrides: Record<string, unknown> = {}) => ({
  rows: 24,
  options: { scrollback: 1000 },
  buffer: { active: { length: 10, baseY: 0 } },
  ...overrides,
}) as unknown as XTerm;

test("tracks long unbroken terminal output pressure until a line break arrives", () => {
  const term = createFakeTerm();

  noteTerminalOutputPressureData(term, "x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES - 1));
  assert.equal(getTerminalOutputPressure(term).longLine, false);

  noteTerminalOutputPressureData(term, "x");
  assert.equal(getTerminalOutputPressure(term).longLine, true);
  assert.equal(getTerminalOutputPressure(term).mode, "long-line");

  noteTerminalOutputPressureData(term, "\nshort");
  assert.equal(getTerminalOutputPressure(term).longLine, false);
  // Crossing the long-line threshold also arms the high-rate large-output window.
  assert.equal(getTerminalOutputPressure(term).largeOutput, true);
  assert.equal(getTerminalOutputPressure(term).mode, "large-output");

  resetTerminalOutputPressure(term);
});

test("reports newline-terminated long terminal lines as long-line pressure", () => {
  const term = createFakeTerm();

  noteTerminalOutputPressureData(term, `${"x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES)}\n`);
  assert.equal(getTerminalOutputPressure(term).longLine, true);
  assert.equal(getTerminalOutputPressure(term).mode, "long-line");
  assert.equal(getTerminalOutputPressure(term).consecutiveUnbrokenBytes, 0);

  noteTerminalOutputPressureData(term, "short\n");
  assert.equal(getTerminalOutputPressure(term).longLine, false);
  assert.equal(getTerminalOutputPressure(term).largeOutput, true);
  assert.equal(getTerminalOutputPressure(term).mode, "large-output");

  resetTerminalOutputPressure(term);
});

test("reports background pressure separately from output volume", () => {
  const term = createFakeTerm();

  setTerminalOutputPressureVisibility(term, false);
  assert.equal(getTerminalOutputPressure(term).background, true);
  assert.equal(getTerminalOutputPressure(term).mode, "background");
  assert.equal(shouldDegradeTerminalSideWork(term), false);

  setTerminalOutputPressureVisibility(term, true);
  assert.equal(getTerminalOutputPressure(term).background, false);
  assert.equal(getTerminalOutputPressure(term).mode, "normal");

  resetTerminalOutputPressure(term);
});

test("keeps large-output pressure through small input echoes until output is quiet", () => {
  const term = createFakeTerm();
  const originalNow = performance.now.bind(performance);
  let now = 1_000;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    noteTerminalOutputPressureData(term, "x\n".repeat(Math.ceil(TERMINAL_LONG_LINE_PRESSURE_BYTES / 2)));
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");

    now += 16;
    noteTerminalOutputPressureData(term, "a");
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");

    now += XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs + 1;
    assert.equal(getTerminalOutputPressure(term).largeOutput, false);
    assert.equal(getTerminalOutputPressure(term).mode, "normal");
  } finally {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: originalNow,
    });
    resetTerminalOutputPressure(term);
  }
});

test("detects large-output pressure from high-rate small chunks", () => {
  const term = createFakeTerm();
  const originalNow = performance.now.bind(performance);
  let now = 5_000;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    // ~16KB of short lines inside the 100ms rate window (not one unbroken run).
    // Threshold is intentionally below one Tabby-sized xterm shard.
    for (let index = 0; index < 16; index += 1) {
      noteTerminalOutputPressureData(term, `${"y".repeat(1023)}\n`);
    }
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(getTerminalOutputPressure(term).longLine, false);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");
  } finally {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: originalNow,
    });
    resetTerminalOutputPressure(term);
  }
});

test("arms large-output early on multi-line writes when scrollback is saturated", () => {
  // rows(24) + scrollback(1000) = 1024 max; length near cap → second-seq path.
  const term = createFakeTerm({
    rows: 24,
    options: { scrollback: 1000 },
    buffer: { active: { length: 1020, baseY: 996 } },
  });
  const originalNow = performance.now.bind(performance);
  let now = 9_000;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    assert.equal(isTerminalScrollbackSaturated(term), true);
    // Far below the long-line / 16KB rate thresholds — only saturated multi-line
    // arming should trip bulk mode (second `seq` cold start).
    noteTerminalOutputPressureData(term, "1\n2\n3\n4\n5\n");
    assert.equal(getTerminalOutputPressure(term).scrollbackSaturated, true);
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(shouldDegradeTerminalSideWork(term), true);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");

    // Quiet window is extended while saturated so prompt-echo gaps do not
    // reopen the expensive timestamp/highlight path before a second dump.
    now += XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs + 1;
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    now += XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs + 1;
    assert.equal(getTerminalOutputPressure(term).largeOutput, false);
  } finally {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: originalNow,
    });
    resetTerminalOutputPressure(term);
  }
});

test("does not treat an empty buffer as scrollback-saturated", () => {
  const term = createFakeTerm({
    rows: 24,
    options: { scrollback: 1000 },
    buffer: { active: { length: 12, baseY: 0 } },
  });
  assert.equal(isTerminalScrollbackSaturated(term), false);
  noteTerminalOutputPressureData(term, "1\n2\n3\n");
  assert.equal(getTerminalOutputPressure(term).largeOutput, false);
  assert.equal(getTerminalOutputPressure(term).scrollbackSaturated, false);
  resetTerminalOutputPressure(term);
});

test("saturated multi-line degrades side work but keeps line timestamps", () => {
  const term = createFakeTerm({
    rows: 24,
    options: { scrollback: 1000 },
    buffer: { active: { length: 1020, baseY: 996 } },
  });

  // docker-ps-sized multi-line on a full scrollback: highlight/prep may degrade,
  // but per-line gutter timestamps must still stamp.
  noteTerminalOutputPressureData(term, "CONTAINER ID   IMAGE\n".repeat(20));
  assert.equal(shouldDegradeTerminalSideWork(term), true);
  assert.equal(shouldSkipTerminalLineTimestamps(term), false);

  resetTerminalOutputPressure(term);
});

test("true flood rate skips line timestamps", () => {
  const term = createFakeTerm();
  const originalNow = performance.now.bind(performance);
  let now = 20_000;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    // 64KB+ inside the rate window → timestamp flood gate.
    for (let index = 0; index < 64; index += 1) {
      noteTerminalOutputPressureData(term, `${"z".repeat(1023)}\n`);
    }
    assert.equal(shouldSkipTerminalLineTimestamps(term), true);
    assert.equal(shouldDegradeTerminalSideWork(term), true);
  } finally {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: originalNow,
    });
    resetTerminalOutputPressure(term);
  }
});

test("rate detector uses a true rolling window across early tiny samples", () => {
  const term = createFakeTerm();
  const originalNow = performance.now.bind(performance);
  let now = 1;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    noteTerminalOutputPressureData(term, "x\n");
    now = 60;
    noteTerminalOutputPressureData(term, `${"x".repeat(40 * 1024)}\n`);
    now = 102;
    noteTerminalOutputPressureData(term, `${"x".repeat(40 * 1024)}\n`);
    // 80KB arrived within 42ms; the tiny sample at t=1 should age out, not reset the window.
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");
  } finally {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: originalNow,
    });
    resetTerminalOutputPressure(term);
  }
});
