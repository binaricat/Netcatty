import type { Terminal as XTerm } from "@xterm/xterm";

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
      longLine: false,
      consecutiveUnbrokenBytes: 0,
    };
    pressureStates.set(term, state);
  }
  return state;
};

const measureUnbrokenRuns = (
  data: string,
  initialRunBytes: number,
): { maxRunBytes: number; trailingRunBytes: number } => {
  let currentRunBytes = initialRunBytes;
  let maxRunBytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === "\n" || char === "\r") {
      currentRunBytes = 0;
      continue;
    }
    currentRunBytes += 1;
    if (currentRunBytes > maxRunBytes) {
      maxRunBytes = currentRunBytes;
    }
  }
  return { maxRunBytes, trailingRunBytes: currentRunBytes };
};

export const noteTerminalOutputPressureData = (
  term: XTerm,
  data: string,
): void => {
  if (!data) return;
  const state = getOrCreateState(term);
  state.largeOutput = data.length >= TERMINAL_LONG_LINE_PRESSURE_BYTES;
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
  getOrCreateState(term).largeOutput = largeOutput;
};

export const getTerminalOutputPressure = (
  term: XTerm,
): TerminalOutputPressureSnapshot => {
  const state = getOrCreateState(term);
  const mode: TerminalOutputPressureMode = state.background
    ? "background"
    : state.longLine
      ? "long-line"
      : state.largeOutput
        ? "large-output"
        : "normal";

  return {
    mode,
    background: state.background,
    largeOutput: state.largeOutput,
    longLine: state.longLine,
    consecutiveUnbrokenBytes: state.consecutiveUnbrokenBytes,
  };
};

export const resetTerminalOutputPressure = (term: XTerm): void => {
  pressureStates.delete(term);
};
