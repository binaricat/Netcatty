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

const endsAtKnownColumnZero = (
  text: string,
  cursorXBeforeWrite: number,
): boolean => {
  if (text.endsWith("\r")) return true;
  if (!text.endsWith("\n")) return false;

  const beforeFinalLineFeed = text.slice(0, -1);
  const lastCarriageReturn = beforeFinalLineFeed.lastIndexOf("\r");
  const sinceColumnReset = beforeFinalLineFeed.slice(lastCarriageReturn + 1);
  if (sinceColumnReset.replaceAll("\n", "").length > 0) return false;
  return lastCarriageReturn >= 0 || cursorXBeforeWrite <= 0;
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
  data: string,
  promptText: string,
  cursorXBeforeWrite: number,
  promptVisibleStarts: readonly number[],
): string => {
  const mapped = mapVisibleText(data);
  const rawStarts = [...new Set(promptVisibleStarts)]
    .sort((left, right) => left - right)
    .flatMap((visibleStart) => {
      if (mapped.text.slice(visibleStart, visibleStart + promptText.length) !== promptText) {
        return [];
      }
      const prefixText = mapped.text.slice(0, visibleStart);
      if (prefixText.length === 0 && cursorXBeforeWrite <= 0) return [];
      if (
        prefixText.length > 0
        && endsAtKnownColumnZero(prefixText, cursorXBeforeWrite)
      ) return [];
      const rawStart = mapped.rawStartByTextIndex[visibleStart];
      return rawStart === undefined ? [] : [rawStart];
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
      data,
      state.lastPromptText,
      cursorXBeforeWrite,
      promptVisibleStarts,
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
