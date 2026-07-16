import type { Terminal as XTerm } from "@xterm/xterm";

import { XTERM_PERFORMANCE_CONFIG } from "../../../infrastructure/config/xtermPerformance";
import { TERMINAL_LONG_LINE_PRESSURE_BYTES } from "./terminalFlowConstants";

export type TerminalOutputPressureMode =
  | "normal"
  | "large-output"
  | "long-line"
  | "background";

export type TerminalOutputPressureSnapshot = {
  mode: TerminalOutputPressureMode;
  background: boolean;
  largeOutput: boolean;
  longLine: boolean;
  /** True when the active buffer is near its scrollback capacity (trim-on-write). */
  scrollbackSaturated: boolean;
  consecutiveUnbrokenBytes: number;
};

type OutputRateSample = {
  at: number;
  bytes: number;
};

type TerminalOutputPressureState = {
  background: boolean;
  largeOutput: boolean;
  largeOutputUntil: number;
  /**
   * Separate, stricter flood gate for line-timestamp markers. Full scrollback +
   * multi-line (e.g. `docker ps`) must NOT drop per-line timestamps — only true
   * high-rate dumps (seq/yes) skip registerMarker storms.
   */
  timestampFloodUntil: number;
  longLine: boolean;
  consecutiveUnbrokenBytes: number;
  /** True rolling window samples for high-rate small-chunk detection. */
  recentSamples: OutputRateSample[];
  recentSampleBytes: number;
};

/**
 * Detect bulk streams that arrive as many small IPC chunks (e.g. `yes`, `seq`).
 *
 * Tabby has almost no write-path side work, so it never needs an explicit
 * "bulk mode". We do (timestamps / keyword highlights), so arm large-output
 * early enough that the *second* dump on a full scrollback does not spend its
 * first ~64KB in the expensive normal path.
 */
const LARGE_OUTPUT_RATE_WINDOW_MS = 100;
/** Lower than a full 128KB xterm shard so pressure leads the first write batch. */
const LARGE_OUTPUT_RATE_BYTES = 16 * 1024;
/**
 * Only skip line-timestamp markers at true flood rates. Early large-output
 * (16KB) and saturated multi-line still degrade highlight/prep, but keep the
 * product rule: each output line can get a gutter timestamp.
 */
const TIMESTAMP_SKIP_RATE_BYTES = 64 * 1024;
/**
 * When scrollback is already full, any multi-line or modest chunk should arm
 * bulk mode: every new line trims, and marker/highlight work multiplies cost.
 */
const SATURATED_SCROLLBACK_BULK_MIN_BYTES = 64;

const pressureStates = new WeakMap<XTerm, TerminalOutputPressureState>();

const getOrCreateState = (term: XTerm): TerminalOutputPressureState => {
  let state = pressureStates.get(term);
  if (!state) {
    state = {
      background: false,
      largeOutput: false,
      largeOutputUntil: 0,
      timestampFloodUntil: 0,
      longLine: false,
      consecutiveUnbrokenBytes: 0,
      recentSamples: [],
      recentSampleBytes: 0,
    };
    pressureStates.set(term, state);
  }
  return state;
};

const noteRecentOutputRate = (
  state: TerminalOutputPressureState,
  now: number,
  bytes: number,
): number => {
  state.recentSamples.push({ at: now, bytes });
  state.recentSampleBytes += bytes;
  const cutoff = now - LARGE_OUTPUT_RATE_WINDOW_MS;
  while (state.recentSamples.length > 0 && state.recentSamples[0]!.at < cutoff) {
    const dropped = state.recentSamples.shift()!;
    state.recentSampleBytes -= dropped.bytes;
  }
  if (state.recentSampleBytes < 0) state.recentSampleBytes = 0;
  return state.recentSampleBytes;
};

const LINE_BREAK_SCAN = /[\n\r]/g;

const measureUnbrokenRuns = (
  data: string,
  initialRunBytes: number,
): { maxRunBytes: number; trailingRunBytes: number } => {
  // Hot path for every output batch: hop between line breaks with a native
  // regex scan instead of visiting each character in JS. A run only counts
  // toward the max when this chunk actually appended characters to it,
  // matching the original per-char accounting.
  let maxRunBytes = 0;
  let runStart = 0;
  let carriedRunBytes = initialRunBytes;
  LINE_BREAK_SCAN.lastIndex = 0;
  for (
    let match = LINE_BREAK_SCAN.exec(data);
    match !== null;
    match = LINE_BREAK_SCAN.exec(data)
  ) {
    const appendedBytes = match.index - runStart;
    if (appendedBytes > 0) {
      const runBytes = carriedRunBytes + appendedBytes;
      if (runBytes > maxRunBytes) {
        maxRunBytes = runBytes;
      }
    }
    carriedRunBytes = 0;
    runStart = match.index + 1;
  }
  const trailingAppendedBytes = data.length - runStart;
  const trailingRunBytes = carriedRunBytes + trailingAppendedBytes;
  if (trailingAppendedBytes > 0 && trailingRunBytes > maxRunBytes) {
    maxRunBytes = trailingRunBytes;
  }
  return { maxRunBytes, trailingRunBytes };
};

const resolveConfiguredScrollback = (term: XTerm): number => {
  const options = (term as XTerm & { options?: { scrollback?: number } }).options;
  const scrollback = options?.scrollback;
  if (typeof scrollback === "number" && Number.isFinite(scrollback) && scrollback > 0) {
    return Math.floor(scrollback);
  }
  return 0;
};

/**
 * True when the active buffer is near capacity so new lines force scrollback
 * trim. Second `seq` dumps hit this path for the entire run; first dumps only
 * after the buffer fills.
 */
export const isTerminalScrollbackSaturated = (term: XTerm): boolean => {
  try {
    const active = term.buffer?.active as
      | { length?: number; baseY?: number }
      | undefined;
    if (!active) return false;
    const rows = Math.max(1, term.rows || 0);
    const scrollback = resolveConfiguredScrollback(term);
    if (scrollback <= 0) return false;
    const maxLines = rows + scrollback;
    const length = typeof active.length === "number" ? active.length : 0;
    if (length <= 0) return false;
    // Treat "within one viewport of full" as saturated — cheap, stable, and
    // matches when xterm starts trimming aggressively on multi-line floods.
    const slack = Math.max(rows, 8);
    return length >= maxLines - slack;
  } catch {
    return false;
  }
};

const markLargeOutput = (
  state: TerminalOutputPressureState,
  now: number,
  quietMs: number,
): void => {
  state.largeOutputUntil = now + quietMs;
  state.largeOutput = true;
};

const resolveLargeOutputQuietMs = (scrollbackSaturated: boolean): number => {
  const base = XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs;
  // Full buffers stay expensive after the dump ends (trim/marker churn). Keep
  // bulk side-work off a bit longer so a second dump does not reopen the
  // expensive path between prompt echoes.
  return scrollbackSaturated ? Math.max(base, base * 2) : base;
};

export const noteTerminalOutputPressureData = (
  term: XTerm,
  data: string,
): void => {
  if (!data) return;
  const state = getOrCreateState(term);
  const now = performance.now();
  const scrollbackSaturated = isTerminalScrollbackSaturated(term);
  const quietMs = resolveLargeOutputQuietMs(scrollbackSaturated);

  const recentBytes = noteRecentOutputRate(state, now, data.length);
  const hasLineBreak = data.includes("\n") || data.includes("\r");
  // Full scrollback + multi-line (seq/logs) or a modest plain chunk → bulk.
  // Tiny single-key echoes without newlines stay on the normal path.
  const saturatedBulkChunk = scrollbackSaturated
    && (
      hasLineBreak
      || data.length >= SATURATED_SCROLLBACK_BULK_MIN_BYTES
    );

  const trueFlood = data.length >= TERMINAL_LONG_LINE_PRESSURE_BYTES
    || recentBytes >= TIMESTAMP_SKIP_RATE_BYTES;

  if (
    data.length >= TERMINAL_LONG_LINE_PRESSURE_BYTES
    || recentBytes >= LARGE_OUTPUT_RATE_BYTES
    || saturatedBulkChunk
  ) {
    markLargeOutput(state, now, quietMs);
  } else if (now >= state.largeOutputUntil) {
    state.largeOutput = false;
  }

  // Timestamp markers: only suppress under true flood / long lines — never for
  // "scrollback full + docker ps" style multi-line output.
  if (trueFlood) {
    state.timestampFloodUntil = now + quietMs;
  }

  const { maxRunBytes, trailingRunBytes } = measureUnbrokenRuns(
    data,
    state.consecutiveUnbrokenBytes,
  );
  state.consecutiveUnbrokenBytes = trailingRunBytes;
  state.longLine = maxRunBytes >= TERMINAL_LONG_LINE_PRESSURE_BYTES;
  if (state.longLine) {
    state.timestampFloodUntil = Math.max(state.timestampFloodUntil, now + quietMs);
  }
};

export const setTerminalOutputPressureVisibility = (
  term: XTerm,
  visible: boolean,
): void => {
  getOrCreateState(term).background = !visible;
};

export const setTerminalOutputPressureLargeOutput = (
  term: XTerm,
  largeOutput: boolean,
): void => {
  const state = getOrCreateState(term);
  state.largeOutput = largeOutput;
  const quietMs = resolveLargeOutputQuietMs(isTerminalScrollbackSaturated(term));
  state.largeOutputUntil = largeOutput
    ? performance.now() + quietMs
    : 0;
  // Explicit large-output flag is used by tests/flood paths that also suppress
  // timestamp storms; clear both gates when turning off.
  if (largeOutput) {
    state.timestampFloodUntil = state.largeOutputUntil;
  } else {
    state.timestampFloodUntil = 0;
  }
};

export const getTerminalOutputPressure = (
  term: XTerm,
): TerminalOutputPressureSnapshot => {
  const state = getOrCreateState(term);
  const scrollbackSaturated = isTerminalScrollbackSaturated(term);
  const largeOutput = state.largeOutput && performance.now() < state.largeOutputUntil;
  const mode: TerminalOutputPressureMode = state.background
    ? "background"
    : state.longLine
      ? "long-line"
      : largeOutput
        ? "large-output"
        : "normal";

  return {
    mode,
    background: state.background,
    largeOutput,
    longLine: state.longLine,
    scrollbackSaturated,
    consecutiveUnbrokenBytes: state.consecutiveUnbrokenBytes,
  };
};

/**
 * True when hot-path side work (highlight scans, prep, coalesce) should degrade
 * so xterm can keep painting bulk output smoothly — closer to Tabby's
 * near-empty write path (FlowControl + xterm.write only).
 */
export const shouldDegradeTerminalSideWork = (term: XTerm): boolean => {
  const pressure = getTerminalOutputPressure(term);
  return pressure.largeOutput || pressure.longLine;
};

/**
 * Whether line-timestamp registerMarker work should be skipped.
 *
 * Stricter than {@link shouldDegradeTerminalSideWork}: full-scrollback multi-line
 * output (docker ps, short command output) must still stamp each line. Only
 * true flood rates / long lines suppress markers.
 */
export const shouldSkipTerminalLineTimestamps = (term: XTerm): boolean => {
  const state = getOrCreateState(term);
  if (state.longLine) return true;
  return performance.now() < state.timestampFloodUntil;
};

export const resetTerminalOutputPressure = (term: XTerm): void => {
  pressureStates.delete(term);
};
