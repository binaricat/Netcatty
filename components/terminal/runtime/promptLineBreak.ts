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
};

type VisibleTextMap = {
  text: string;
  rawStartByTextIndex: number[];
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
  let nextVisibleSegmentStart = 0;

  const appendVisible = (index: number, char: string) => {
    rawStartByTextIndex.push(nextVisibleSegmentStart);
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

  return { text, rawStartByTextIndex };
};

const endsWithLineBreak = (text: string): boolean => {
  const last = text[text.length - 1];
  return last === "\n" || last === "\r";
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
  };
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
): string {
  if (!data || !promptText) return data;

  const mapped = mapVisibleText(data);
  if (!mapped.text.endsWith(promptText)) return data;

  const promptTextStart = mapped.text.length - promptText.length;
  const prefixText = mapped.text.slice(0, promptTextStart);
  if (prefixText.length === 0 && cursorXBeforeWrite <= 0) return data;
  if (prefixText.length > 0) {
    if (endsWithLineBreak(prefixText)) return data;
    if (!isDistinctPromptText(promptText)) return data;
  }

  const promptRawStart = mapped.rawStartByTextIndex[promptTextStart] ?? 0;
  return `${data.slice(0, promptRawStart)}\r\n${data.slice(promptRawStart)}`;
}

export function prepareTerminalDataForPromptLineBreak(
  term: XTerm,
  data: string,
  state: PromptLineBreakState | undefined,
  enabled: boolean,
): string {
  if (!enabled || !state?.pendingCommand || !state.lastPromptText) return data;

  const cursorXBeforeWrite = getCursorX(term);
  const nextData = insertPromptLineBreakBeforePrompt(
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
