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

const CURSOR_PREFIX_CSI_FINALS = new Set([
  "@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "L", "M",
  "P", "S", "T", "X", "Z", "`", "a", "d", "e", "f", "r",
  "s", "u",
]);

const CURSOR_AFFECTING_PRIVATE_MODES = new Set([3, 6, 47, 1047, 1048, 1049]);

const isCursorAffectingCsiSequence = (sequence: CsiSequence): boolean => {
  if (CURSOR_PREFIX_CSI_FINALS.has(sequence.final)) return true;
  if ((sequence.final !== "h" && sequence.final !== "l") || !sequence.body.startsWith("?")) {
    return false;
  }
  return sequence.body.slice(1).split(";").some((part) => {
    const mode = Number.parseInt(part.split(":", 1)[0] ?? "", 10);
    return CURSOR_AFFECTING_PRIVATE_MODES.has(mode);
  });
};

const advancePromptBreakPastLeadingCursorControls = (
  data: string,
  rawStart: number,
  firstVisibleRawIndex: number,
): number => {
  let breakIndex = rawStart;
  for (let index = rawStart; index < firstVisibleRawIndex; index += 1) {
    const char = data[index];
    if (char === ESC || char === "\x9b") {
      const isCsi = char === "\x9b" || data[index + 1] === "[";
      if (isCsi) {
        const sequence = readCsiSequence(data, index);
        if (!sequence || sequence.end >= firstVisibleRawIndex) break;
        if (isCursorAffectingCsiSequence(sequence)) {
          breakIndex = sequence.end + 1;
        }
        index = sequence.end;
        continue;
      }

      const next = data[index + 1];
      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        const end = readControlStringEnd(data, index + 2);
        if (end === null || end >= firstVisibleRawIndex) break;
        index = end;
        continue;
      }
      if (["7", "8", "D", "E", "H", "M", "c"].includes(next)) {
        breakIndex = index + 2;
      }
      if (next) index += 1;
    }
  }
  return breakIndex;
};

type PromptPrefixMeasurement = {
  column: number;
  separated: boolean;
};

const measurePromptPrefixColumn = (
  term: XTerm,
  data: string,
  startColumn: number,
  convertEol: boolean,
): PromptPrefixMeasurement | null => {
  const maxColumn = Number.isFinite(term.cols) && term.cols > 0
    ? term.cols - 1
    : Number.MAX_SAFE_INTEGER;
  const clampColumn = (value: number) => Math.max(0, Math.min(maxColumn, value));
  const parameterCount = (params: readonly number[], index = 0) => Math.max(1, params[index] || 1);
  let column = clampColumn(startColumn);
  let columnKnown = true;
  let newlineMode = convertEol;
  let hasSavedColumn = false;
  let savedColumn: number | null = null;
  let lastPrintableWidth: number | null = null;
  let separated = false;

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
            // CUF clamps at the margin in xterm; it does not wrap.
            if (columnKnown) column = clampColumn(column + count);
            break;
          case "D":
            if (privateOrIntermediate) return null;
            if (columnKnown) column = clampColumn(column - count);
            break;
          case "G":
          case "`":
            if (privateOrIntermediate) return null;
            column = clampColumn(count - 1);
            columnKnown = true;
            break;
          case "H":
          case "f":
            if (privateOrIntermediate) return null;
            column = clampColumn(parameterCount(params, 1) - 1);
            columnKnown = true;
            separated = true;
            break;
          case "E":
          case "F":
            if (privateOrIntermediate) return null;
            column = 0;
            columnKnown = true;
            separated = true;
            break;
          case "I":
          case "Z":
            if (privateOrIntermediate) return null;
            // HTS/TBC can replace the default 8-column stops. Without reading
            // xterm's private tab map, the resulting column is unknown.
            columnKnown = false;
            break;
          case "s":
            if (privateOrIntermediate || params.length > 0) return null;
            hasSavedColumn = true;
            savedColumn = columnKnown ? column : null;
            break;
          case "u":
            if (privateOrIntermediate || params.length > 0 || !hasSavedColumn) return null;
            columnKnown = savedColumn !== null;
            if (savedColumn !== null) column = savedColumn;
            break;
          case "b":
            if (privateOrIntermediate || lastPrintableWidth === null) return null;
            if (columnKnown) {
              // REP repeats a printable; model simple line wrap like printables.
              for (let rep = 0; rep < count; rep += 1) {
                for (let width = 0; width < lastPrintableWidth; width += 1) {
                  if (column >= maxColumn) {
                    column = 0;
                    separated = true;
                  } else {
                    column += 1;
                  }
                }
              }
            }
            break;
          case "r":
            if (privateOrIntermediate) return null;
            column = 0;
            columnKnown = true;
            separated = true;
            break;
          case "A":
          case "B":
            if (privateOrIntermediate) return null;
            separated = true;
            break;
          case "J":
          case "K":
          case "P":
          case "S":
          case "T":
          case "X":
          case "@":
          case "c":
          case "m":
          case "n":
          case "q":
            break;
          case "d":
          case "e":
            if (privateOrIntermediate) return null;
            separated = true;
            break;
          case "L":
          case "M":
            if (privateOrIntermediate) return null;
            column = 0;
            columnKnown = true;
            break;
          case "h":
          case "l":
            if (!privateOrIntermediate && params.includes(20)) {
              newlineMode = sequence.final === "h";
            }
            break;
          default:
            columnKnown = false;
            break;
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
        hasSavedColumn = true;
        savedColumn = columnKnown ? column : null;
        index += 1;
        continue;
      }
      if (next === "8") {
        if (!hasSavedColumn) return null;
        columnKnown = savedColumn !== null;
        if (savedColumn !== null) column = savedColumn;
        index += 1;
        continue;
      }
      if (next === "E" || next === "c") {
        column = 0;
        columnKnown = true;
        separated = true;
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
      separated = true;
      if (newlineMode) {
        column = 0;
        columnKnown = true;
      }
      continue;
    }
    if (char === "\r") {
      column = 0;
      columnKnown = true;
      separated = true;
      continue;
    }
    if (char === "\b") {
      if (columnKnown) column = Math.max(0, column - 1);
      continue;
    }
    if (char === "\t") {
      columnKnown = false;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      if (code === 0 || code === 7 || code === 14 || code === 15) continue;
      columnKnown = false;
      continue;
    }
    if (code > 0x7e) {
      columnKnown = false;
      lastPrintableWidth = null;
      continue;
    }
    lastPrintableWidth = 1;
    if (columnKnown) {
      if (column >= maxColumn) {
        // Simple wrap: a full-width line leaves the cursor at column 0 of the
        // next row. Clamping at cols-1 falsely looked mid-line and inserted an
        // extra blank before the following prompt.
        column = 0;
        separated = true;
      } else {
        column = column + 1;
      }
    }
  }

  return columnKnown ? { column, separated } : null;
};

const endsAtKnownColumnZero = (
  term: XTerm,
  rawText: string,
  visibleText: string,
  cursorXBeforeWrite: number,
  convertEol: boolean,
): boolean => {
  const measured = measurePromptPrefixColumn(term, rawText, cursorXBeforeWrite, convertEol);
  return measured?.column === 0 && (measured.separated || endsWithLineBreak(visibleText));
};

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
      const leadingControlsRawStart = mapped.rawStartByTextIndex[visibleStart];
      const firstVisibleRawIndex = mapped.rawIndexByTextIndex[visibleStart];
      if (leadingControlsRawStart === undefined || firstVisibleRawIndex === undefined) return [];
      const rawStart = advancePromptBreakPastLeadingCursorControls(
        data,
        leadingControlsRawStart,
        firstVisibleRawIndex,
      );
      const prefixText = mapped.text.slice(0, visibleStart);
      const lastColumnResetVisibleIndex = prefixText.lastIndexOf("\r");
      const lastColumnResetRawIndex = lastColumnResetVisibleIndex >= 0
        ? mapped.rawIndexByTextIndex[lastColumnResetVisibleIndex]
        : undefined;
      const measuredRawStart = lastColumnResetRawIndex === undefined
        ? 0
        : lastColumnResetRawIndex + 1;
      const measuredRawText = data.slice(measuredRawStart, rawStart);
      if (endsAtKnownColumnZero(
        term,
        measuredRawText,
        prefixText,
        lastColumnResetRawIndex === undefined ? cursorXBeforeWrite : 0,
        convertEol,
      )) return [];
      if (
        prefixText.length === 0
        && measuredRawText.length === 0
        && cursorXBeforeWrite <= 0
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
