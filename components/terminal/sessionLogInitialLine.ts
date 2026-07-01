type BufferLineLike = {
  isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
};

type ActiveBufferLike = {
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine(line: number): BufferLineLike | undefined;
};

export type TerminalSessionLogInitialLineSource = {
  buffer: {
    active: ActiveBufferLike;
  };
};

type PromptDetectionLike = {
  isAtPrompt: boolean;
  promptText: string;
};

const PROMPT_END_RE = /(?:[$#%]\s|[❯❮→➜➤⟩»›]\s|[\uE000-\uF8FF]\s)$/u;
const CMD_PROMPT_RE = /^[A-Za-z]:\\.*>$/;

export function getSessionLogInitialLine(term: TerminalSessionLogInitialLineSource): string {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const currentPrefix = getLogicalLinePrefix(buffer, cursorY, buffer.cursorX);

  if (looksLikeTrustedPrompt(detectPromptInText(currentPrefix))) {
    return currentPrefix;
  }

  const promptLine = findNearestPromptLine(buffer, cursorY);
  if (promptLine) {
    return promptLine;
  }

  return currentPrefix;
}

function findNearestPromptLine(buffer: ActiveBufferLike, cursorY: number): string {
  const visitedStartRows = new Set<number>();

  for (let row = cursorY; row >= 0; row -= 1) {
    const startRow = findLogicalLineStart(buffer, row);
    if (visitedStartRows.has(startRow)) continue;
    visitedStartRows.add(startRow);

    const logicalLine = getLogicalLineText(buffer, row);
    const prompt = detectPromptInText(logicalLine);
    if (looksLikeTrustedPrompt(prompt)) {
      return logicalLine;
    }
  }

  return "";
}

function getLogicalLinePrefix(buffer: ActiveBufferLike, row: number, cursorX: number): string {
  const startRow = findLogicalLineStart(buffer, row);
  const currentLine = buffer.getLine(row);
  if (!currentLine) return "";

  let text = "";
  for (let lineRow = startRow; lineRow < row; lineRow += 1) {
    text += buffer.getLine(lineRow)?.translateToString(false) ?? "";
  }

  text += currentLine.translateToString(false).substring(0, Math.max(0, cursorX));
  return text;
}

function getLogicalLineText(buffer: ActiveBufferLike, row: number): string {
  const startRow = findLogicalLineStart(buffer, row);
  const endRow = findLogicalLineEnd(buffer, row);

  let text = "";
  for (let lineRow = startRow; lineRow <= endRow; lineRow += 1) {
    text += buffer.getLine(lineRow)?.translateToString(false) ?? "";
  }
  return text;
}

function findLogicalLineStart(buffer: ActiveBufferLike, row: number): number {
  let startRow = row;
  while (startRow > 0) {
    const line = buffer.getLine(startRow);
    if (!line?.isWrapped) break;
    startRow -= 1;
  }
  return startRow;
}

function findLogicalLineEnd(buffer: ActiveBufferLike, row: number): number {
  let endRow = row;
  while (true) {
    const nextLine = buffer.getLine(endRow + 1);
    if (!nextLine?.isWrapped) break;
    endRow += 1;
  }
  return endRow;
}

function detectPromptInText(text: string): PromptDetectionLike {
  const promptText = findPromptText(text);
  if (!promptText) {
    return { isAtPrompt: false, promptText: "" };
  }

  return { isAtPrompt: true, promptText };
}

function findPromptText(text: string): string {
  if (!text) return "";

  const standardMatch = text.match(/^.*(?:[$#%]|[❯❮→➜➤⟩»›]|[\uE000-\uF8FF])\s/u);
  if (standardMatch) {
    return standardMatch[0];
  }

  const trimmed = text.trimEnd();
  const cmdPromptMatch = trimmed.match(/^[A-Za-z]:\\.*>/);
  if (cmdPromptMatch) {
    return cmdPromptMatch[0];
  }

  return "";
}

function looksLikeTrustedPrompt(prompt: PromptDetectionLike): boolean {
  if (!prompt.isAtPrompt) return false;
  const { promptText } = prompt;
  if (PROMPT_END_RE.test(promptText)) return true;
  return CMD_PROMPT_RE.test(promptText.trimEnd());
}
