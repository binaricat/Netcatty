import type { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import {
  detectPrompt,
  getAlignedPrompt,
  isNonPromptLine,
  reconcilePromptWithExternalCommand,
} from "../autocomplete/promptDetector";

export type PromptLineBreakState = {
  lastPromptText: string;
  pendingCommand: boolean;
  suppressNextPromptCache: boolean;
  pendingCommandCompletions: number;
};

type VisibleTextMap = {
  text: string;
  rawStartByTextIndex: number[];
  rawIndexByTextIndex: number[];
};

const ESC = "\x1b";
const BEL = "\x07";

const isCsiFinalByte = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
};

const mapVisibleText = (data: string): VisibleTextMap => {
  let text = "";
  const rawStartByTextIndex: number[] = [];
  const rawIndexByTextIndex: number[] = [];
  let nextVisibleSegmentStart = 0;

  const appendVisible = (index: number, char: string) => {
    rawStartByTextIndex.push(nextVisibleSegmentStart);
    rawIndexByTextIndex.push(index);
    text += char;
    nextVisibleSegmentStart = index + char.length;
  };

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char !== ESC) {
      appendVisible(index, char);
      continue;
    }

    const nextChar = data[index + 1];
    if (nextChar === "[") {
      index += 2;
      while (index < data.length && !isCsiFinalByte(data[index])) {
        index += 1;
      }
      continue;
    }

    if (nextChar === "]") {
      index += 2;
      while (index < data.length) {
        if (data[index] === BEL) break;
        if (data[index] === ESC && data[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (nextChar) {
      index += 1;
    }
  }

  return { text, rawStartByTextIndex, rawIndexByTextIndex };
};

const endsWithLineBreak = (text: string): boolean => {
  const last = text[text.length - 1];
  return last === "\n" || last === "\r";
};

type CsiSequence = {
  body: string;
  end: number;
  final: string;
};

const readCsiSequence = (data: string, index: number): CsiSequence | null => {
  const parameterStart = data[index] === ESC ? index + 2 : index + 1;
  if (data[index] === ESC && data[index + 1] !== "[") return null;
  for (let end = parameterStart; end < data.length; end += 1) {
    if (!isCsiFinalByte(data[end])) continue;
    return {
      body: data.slice(parameterStart, end),
      end,
      final: data[end],
    };
  }
  return null;
};

const readControlStringEnd = (data: string, start: number): number | null => {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === BEL) return index;
    if (data[index] === ESC && data[index + 1] === "\\") return index + 1;
  }
  return null;
};

const parseCsiParams = (body: string): number[] => {
  const parameterText = body.match(/^[0-9;:]*/)?.[0] ?? "";
  if (!parameterText) return [];
  return parameterText.split(";").map((part) => {
    const value = Number.parseInt(part.split(":", 1)[0] ?? "", 10);
    return Number.isFinite(value) ? value : 0;
  });
};

const measurePromptPrefixColumn = (
  term: XTerm,
  data: string,
  startColumn: number,
  convertEol: boolean,
): number | null => {
  const maxColumn = Number.isFinite(term.cols) && term.cols > 0
    ? term.cols - 1
    : Number.MAX_SAFE_INTEGER;
  const clampColumn = (value: number) => Math.max(0, Math.min(maxColumn, value));
  const parameterCount = (params: readonly number[], index = 0) => Math.max(1, params[index] || 1);
  let column = clampColumn(startColumn);
  let savedColumn: number | null = null;
  let lastPrintableWidth: number | null = null;

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === ESC || char === "\x9b") {
      const isCsi = char === "\x9b" || data[index + 1] === "[";
      if (isCsi) {
        const sequence = readCsiSequence(data, index);
        if (!sequence) return null;
        const params = parseCsiParams(sequence.body);
        const privateOrIntermediate = sequence.body.slice(
          sequence.body.match(/^[0-9;:]*/)?.[0].length ?? 0,
        );
        const count = parameterCount(params);
        switch (sequence.final) {
          case "C":
          case "a":
            if (privateOrIntermediate) return null;
            column = clampColumn(column + count);
            break;
          case "D":
            if (privateOrIntermediate) return null;
            column = clampColumn(column - count);
            break;
          case "G":
          case "`":
            if (privateOrIntermediate) return null;
            column = clampColumn(count - 1);
            break;
          case "H":
          case "f":
            if (privateOrIntermediate) return null;
            column = clampColumn(parameterCount(params, 1) - 1);
            break;
          case "E":
          case "F":
            if (privateOrIntermediate) return null;
            column = 0;
            break;
          case "I":
            if (privateOrIntermediate) return null;
            for (let tab = 0; tab < count; tab += 1) {
              column = clampColumn(column + (8 - (column % 8)));
            }
            break;
          case "Z":
            if (privateOrIntermediate) return null;
            for (let tab = 0; tab < count; tab += 1) {
              column = Math.max(0, column - (column % 8 || 8));
            }
            break;
          case "s":
            if (privateOrIntermediate || params.length > 0) return null;
            savedColumn = column;
            break;
          case "u":
            if (privateOrIntermediate || params.length > 0 || savedColumn === null) return null;
            column = savedColumn;
            break;
          case "b":
            if (privateOrIntermediate || lastPrintableWidth === null) return null;
            column = clampColumn(column + (lastPrintableWidth * count));
            break;
          case "r":
            if (privateOrIntermediate) return null;
            column = 0;
            break;
          case "A":
          case "B":
          case "J":
          case "K":
          case "L":
          case "M":
          case "P":
          case "S":
          case "T":
          case "X":
          case "@":
          case "c":
          case "d":
          case "e":
          case "h":
          case "l":
          case "m":
          case "n":
          case "q":
            break;
          default:
            return null;
        }
        index = sequence.end;
        continue;
      }

      const next = data[index + 1];
      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        const end = readControlStringEnd(data, index + 2);
        if (end === null) return null;
        index = end;
        continue;
      }
      if (next === "7") {
        savedColumn = column;
        index += 1;
        continue;
      }
      if (next === "8") {
        if (savedColumn === null) return null;
        column = savedColumn;
        index += 1;
        continue;
      }
      if (next === "E" || next === "c") {
        column = 0;
        index += 1;
        continue;
      }
      if (next === "D" || next === "M" || next === "=" || next === ">" || next === "H") {
        index += 1;
        continue;
      }
      if (["(", ")", "*", "+", "-", ".", "/"].includes(next) && data[index + 2]) {
        index += 2;
        continue;
      }
      return null;
    }

    if (char === "\n" || char === "\v" || char === "\f") {
      if (convertEol) column = 0;
      continue;
    }
    if (char === "\r") {
      column = 0;
      continue;
    }
    if (char === "\b") {
      column = Math.max(0, column - 1);
      continue;
    }
    if (char === "\t") {
      column = clampColumn(column + (8 - (column % 8)));
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      if (code === 0 || code === 7 || code === 14 || code === 15) continue;
      return null;
    }
    if (code > 0x7e) return null;
    lastPrintableWidth = 1;
    column = clampColumn(column + 1);
  }

  return column;
};

const endsAtKnownColumnZero = (
  term: XTerm,
  rawText: string,
  visibleText: string,
  cursorXBeforeWrite: number,
  convertEol: boolean,
): boolean => (
  endsWithLineBreak(visibleText)
  && measurePromptPrefixColumn(term, rawText, cursorXBeforeWrite, convertEol) === 0
);

const containsLineReset = (text: string): boolean =>
  text.includes("\n") || text.includes("\r");

const hasAmbiguousPromptSuffix = (data: string, promptText: string): boolean => {
  const mapped = mapVisibleText(data);
  if (!mapped.text.endsWith(promptText)) return false;

  const promptTextStart = mapped.text.length - promptText.length;
  const prefixText = mapped.text.slice(0, promptTextStart);
  return prefixText.length > 0 && !endsWithLineBreak(prefixText);
};

const isDistinctPromptText = (promptText: string): boolean => {
  const trimmed = promptText.trim();
  if (trimmed.length >= 8) return true;
  return trimmed.length >= 6 && /[@:\\/]/.test(trimmed);
};

const getCursorX = (term: XTerm): number => {
  try {
    return term.buffer.active.cursorX;
  } catch {
    return 0;
  }
};

const getConvertEol = (term: XTerm): boolean => {
  try {
    return term.options.convertEol === true;
  } catch {
    return false;
  }
};

export function createPromptLineBreakState(): PromptLineBreakState {
  return {
    lastPromptText: "",
    pendingCommand: false,
    suppressNextPromptCache: false,
    pendingCommandCompletions: 0,
  };
}

export function markTerminalCommandCompletionPending(
  stateRef?: RefObject<PromptLineBreakState>,
): void {
  if (!stateRef?.current) return;
  stateRef.current.pendingCommandCompletions = Math.min(
    64,
    stateRef.current.pendingCommandCompletions + 1,
  );
}

export function consumeTerminalCommandCompletion(
  state: PromptLineBreakState | undefined,
): boolean {
  if (!state || state.pendingCommandCompletions < 1) return false;
  state.pendingCommandCompletions -= 1;
  return true;
}

export function consumeOsc133CommandCompletion(
  data: string,
  state: PromptLineBreakState | undefined,
): boolean {
  return data.split(";", 1)[0] === "D" && consumeTerminalCommandCompletion(state);
}

export function detectTerminalCommandCompletions(
  term: XTerm,
  state: PromptLineBreakState | undefined,
): number {
  if (!state || state.pendingCommandCompletions < 1) return 0;
  const prompt = detectPrompt(term);
  if (!prompt.isAtPrompt || prompt.userInput.length > 0) return 0;
  const completed = state.pendingCommandCompletions;
  state.pendingCommandCompletions = 0;
  return completed;
}

export function markPromptLineBreakCommandPending(
  stateRef?: RefObject<PromptLineBreakState>,
  term?: XTerm | null,
  command?: string,
): void {
  if (!stateRef?.current) return;
  if (term) {
    const cachedFromCommand = command
      ? cachePromptLineBreakPromptFromCommand(term, stateRef.current, command)
      : false;
    if (!cachedFromCommand) {
      cachePromptLineBreakPrompt(term, stateRef.current);
    }
  }
  stateRef.current.pendingCommand = true;
  stateRef.current.suppressNextPromptCache = false;
}

function cachePromptLineBreakPromptFromCommand(
  term: XTerm,
  state: PromptLineBreakState | undefined,
  command: string,
): boolean {
  const trimmedCommand = command.trim();
  if (!state || trimmedCommand.length === 0) return false;

  const aligned = getAlignedPrompt(term, trimmedCommand, true);
  if (!aligned.prompt.isAtPrompt) {
    state.lastPromptText = "";
    state.suppressNextPromptCache = false;
    return false;
  }
  if (isNonPromptLine(`${aligned.prompt.promptText}${trimmedCommand}`)) {
    state.lastPromptText = "";
    state.suppressNextPromptCache = false;
    return true;
  }

  const prompt =
    aligned.alignedTyped === trimmedCommand
      ? aligned.prompt
      : reconcilePromptWithExternalCommand(aligned.prompt, trimmedCommand);
  if (!prompt) {
    state.lastPromptText = "";
    state.suppressNextPromptCache = false;
    return false;
  }

  state.lastPromptText = prompt.promptText;
  state.suppressNextPromptCache = false;
  return true;
}

export function cachePromptLineBreakPrompt(
  term: XTerm,
  state: PromptLineBreakState | undefined,
): void {
  if (!state) return;

  const prompt = detectPrompt(term);
  if (!prompt.isAtPrompt) return;
  if (prompt.userInput.length > 0) return;

  state.lastPromptText = prompt.promptText;
  state.suppressNextPromptCache = false;
}

export function insertPromptLineBreakBeforePrompt(
  data: string,
  promptText: string,
  cursorXBeforeWrite: number,
  promptStartsAtSourceChunk = false,
): string {
  if (!data || !promptText) return data;

  const mapped = mapVisibleText(data);
  if (!mapped.text.endsWith(promptText)) return data;

  const promptTextStart = mapped.text.length - promptText.length;
  const prefixText = mapped.text.slice(0, promptTextStart);
  const promptRawStart = mapped.rawStartByTextIndex[promptTextStart] ?? 0;
  if (prefixText.length === 0 && cursorXBeforeWrite <= 0) return data;
  if (prefixText.length > 0) {
    if (endsWithLineBreak(prefixText)) return data;
    if (!isDistinctPromptText(promptText) && !promptStartsAtSourceChunk) return data;
  }

  return `${data.slice(0, promptRawStart)}\r\n${data.slice(promptRawStart)}`;
}

const lowerBoundRawIndex = (rawIndexes: readonly number[], target: number): number => {
  let low = 0;
  let high = rawIndexes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rawIndexes[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

export function findTerminalPromptSourceChunkVisibleStarts(
  data: string,
  promptText: string,
  sourceChunkBoundaries: readonly number[] = [],
): number[] {
  if (!data || !promptText) return [];

  const mapped = mapVisibleText(data);
  const boundaries = [
    0,
    ...sourceChunkBoundaries.filter(
      (boundary, index) => (
        boundary > 0
        && boundary < data.length
        && (index === 0 || boundary > sourceChunkBoundaries[index - 1])
      ),
    ),
    data.length,
  ];
  const promptVisibleStarts: number[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const chunkVisibleStart = lowerBoundRawIndex(
      mapped.rawIndexByTextIndex,
      boundaries[index],
    );
    const chunkVisibleEnd = lowerBoundRawIndex(
      mapped.rawIndexByTextIndex,
      boundaries[index + 1],
    );
    if (chunkVisibleEnd <= chunkVisibleStart) continue;

    const chunkText = mapped.text.slice(chunkVisibleStart, chunkVisibleEnd);
    if (!chunkText.endsWith(promptText)) continue;
    const promptVisibleStart = chunkVisibleEnd - promptText.length;
    const chunkPrefix = mapped.text.slice(chunkVisibleStart, promptVisibleStart);
    if (chunkPrefix.length > 0 && !isDistinctPromptText(promptText)) continue;
    promptVisibleStarts.push(promptVisibleStart);
  }

  return promptVisibleStarts;
}

const insertPromptLineBreaksAtVisibleStarts = (
  term: XTerm,
  data: string,
  promptText: string,
  cursorXBeforeWrite: number,
  promptVisibleStarts: readonly number[],
  convertEol: boolean,
): string => {
  const mapped = mapVisibleText(data);
  const rawStarts = [...new Set(promptVisibleStarts)]
    .sort((left, right) => left - right)
    .flatMap((visibleStart) => {
      if (mapped.text.slice(visibleStart, visibleStart + promptText.length) !== promptText) {
        return [];
      }
      const rawStart = mapped.rawStartByTextIndex[visibleStart];
      if (rawStart === undefined) return [];
      const prefixText = mapped.text.slice(0, visibleStart);
      if (prefixText.length === 0 && cursorXBeforeWrite <= 0) return [];
      if (
        prefixText.length > 0
        && endsAtKnownColumnZero(
          term,
          data.slice(0, rawStart),
          prefixText,
          cursorXBeforeWrite,
          convertEol,
        )
      ) return [];
      return [rawStart];
    });
  if (rawStarts.length === 0) return data;

  let result = "";
  let lastRawIndex = 0;
  for (const rawStart of rawStarts) {
    result += `${data.slice(lastRawIndex, rawStart)}\r\n`;
    lastRawIndex = rawStart;
  }
  return `${result}${data.slice(lastRawIndex)}`;
};

export function prepareTerminalDataForPromptLineBreak(
  term: XTerm,
  data: string,
  state: PromptLineBreakState | undefined,
  enabled: boolean,
  promptVisibleStarts: readonly number[] = [],
): string {
  if (!enabled || !state?.pendingCommand || !state.lastPromptText) return data;

  const cursorXBeforeWrite = getCursorX(term);
  const nextData = promptVisibleStarts.length > 0
    ? insertPromptLineBreaksAtVisibleStarts(
      term,
      data,
      state.lastPromptText,
      cursorXBeforeWrite,
      promptVisibleStarts,
      getConvertEol(term),
    )
    : insertPromptLineBreakBeforePrompt(
      data,
      state.lastPromptText,
      cursorXBeforeWrite,
    );
  const visibleText = mapVisibleText(data).text;
  const ambiguousPromptSuffix = hasAmbiguousPromptSuffix(data, state.lastPromptText);
  state.suppressNextPromptCache =
    nextData === data &&
    (ambiguousPromptSuffix ||
      (cursorXBeforeWrite > 0 && !containsLineReset(visibleText)));
  return nextData;
}

export function syncPromptLineBreakState(term: XTerm, state?: PromptLineBreakState): void {
  if (!state) return;

  const prompt = detectPrompt(term);
  if (!prompt.isAtPrompt || prompt.userInput.length > 0) return;

  if (state.pendingCommand && state.suppressNextPromptCache) {
    state.suppressNextPromptCache = false;
    return;
  }

  state.lastPromptText = prompt.promptText;
  state.suppressNextPromptCache = false;
  state.pendingCommand = false;
}
