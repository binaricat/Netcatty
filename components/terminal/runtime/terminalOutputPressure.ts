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
  consecutiveUnbrokenBytes: number;
};

type TerminalOutputPressureState = {
  background: boolean;
  largeOutput: boolean;
  largeOutputUntil: number;
  longLine: boolean;
  consecutiveUnbrokenBytes: number;
};

const pressureStates = new WeakMap<XTerm, TerminalOutputPressureState>();

const getOrCreateState = (term: XTerm): TerminalOutputPressureState => {
  let state = pressureStates.get(term);
  if (!state) {
    state = {
      background: false,
      largeOutput: false,
      largeOutputUntil: 0,
      longLine: false,
      consecutiveUnbrokenBytes: 0,
    };
    pressureStates.set(term, state);
  }
  return state;
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

export const noteTerminalOutputPressureData = (
  term: XTerm,
  data: string,
): void => {
  if (!data) return;
  const state = getOrCreateState(term);
  const now = performance.now();
  if (data.length >= TERMINAL_LONG_LINE_PRESSURE_BYTES) {
    state.largeOutputUntil = now + XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs;
    state.largeOutput = true;
  } else if (now >= state.largeOutputUntil) {
    state.largeOutput = false;
  }
  const { maxRunBytes, trailingRunBytes } = measureUnbrokenRuns(
    data,
    state.consecutiveUnbrokenBytes,
  );
  state.consecutiveUnbrokenBytes = trailingRunBytes;
  state.longLine = maxRunBytes >= TERMINAL_LONG_LINE_PRESSURE_BYTES;
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
  state.largeOutputUntil = largeOutput
    ? performance.now() + XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs
    : 0;
};

export const getTerminalOutputPressure = (
  term: XTerm,
): TerminalOutputPressureSnapshot => {
  const state = getOrCreateState(term);
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
    consecutiveUnbrokenBytes: state.consecutiveUnbrokenBytes,
  };
};

export const resetTerminalOutputPressure = (term: XTerm): void => {
  pressureStates.delete(term);
};
