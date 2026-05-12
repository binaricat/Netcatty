import type { Terminal as XTerm } from "@xterm/xterm";

type PasteTarget = Pick<XTerm, "paste" | "scrollToBottom"> &
  Partial<Pick<XTerm, "cols" | "rows" | "write">>;

type PasteOptions = {
  scrollOnPaste?: boolean;
  requestAnimationFrame?: (callback: () => void) => unknown;
};

type PasteDisplayState = {
  expiresAt: number;
  clearPending: number;
  pasteEchoFragments: string[];
  inPasteEchoActiveRegion: boolean;
};

type PasteInputScrollState = {
  expiresAt: number;
  remainingDataVariants: string[];
};

const pasteDisplayStates = new WeakMap<object, PasteDisplayState>();
const pasteInputScrollStates = new WeakMap<object, PasteInputScrollState>();
const LONG_PASTE_MIN_LENGTH = 200;
const PASTE_DISPLAY_FIX_WINDOW_MS = 4000;
const PASTE_INPUT_SCROLL_WINDOW_MS = 4000;
const READLINE_ACTIVE_REGION_START = "\x1b[7m";
const READLINE_ACTIVE_REGION_END = "\x1b[27m";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const MIN_PASTE_ECHO_FRAGMENT_LENGTH = 6;
const ESC = "\x1b";
const BEL = "\x07";

const getNow = () => Date.now();

const isStateActive = <T extends { expiresAt: number }>(state: T | undefined): state is T =>
  !!state && state.expiresAt > getNow();

const stripReadlineActiveRegion = (data: string): string =>
  data
    .split(READLINE_ACTIVE_REGION_START)
    .join("")
    .split(READLINE_ACTIVE_REGION_END)
    .join("");

const isCsiFinalByte = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
};

const stripAnsiEscapeSequences = (data: string): string => {
  let plainText = "";

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char !== ESC) {
      plainText += char;
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

  return plainText;
};

const stripNonLineBreakControls = (data: string): string => {
  let plainText = "";
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (char === "\n" || (code >= 0x20 && code !== 0x7f)) {
      plainText += char;
    }
  }
  return plainText;
};

const getPlainTerminalText = (data: string): string =>
  stripNonLineBreakControls(
    stripAnsiEscapeSequences(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  );

const getPasteEchoFragments = (text: string): string[] =>
  Array.from(
    new Set(
      getPlainTerminalText(text)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_PASTE_ECHO_FRAGMENT_LENGTH),
    ),
  );

const preparePasteTextForXterm = (text: string): string => text.replace(/\r?\n/g, "\r");

const getPasteInputDataVariants = (text: string): string[] => {
  const preparedText = preparePasteTextForXterm(text);
  return Array.from(
    new Set([
      preparedText,
      `${BRACKETED_PASTE_START}${preparedText}${BRACKETED_PASTE_END}`,
    ]),
  ).filter((candidate) => candidate.length > 0);
};

const isExpectedPasteEcho = (data: string, state: PasteDisplayState): boolean => {
  if (state.pasteEchoFragments.length === 0) return false;

  const candidateLines = getPlainTerminalText(stripReadlineActiveRegion(data))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_PASTE_ECHO_FRAGMENT_LENGTH);

  return candidateLines.some((line) =>
    state.pasteEchoFragments.some((fragment) => fragment.includes(line) || line.includes(fragment)),
  );
};

const stripMatchedReadlineActiveRegion = (
  data: string,
  state: PasteDisplayState,
): { data: string; matched: boolean } => {
  let index = 0;
  let matched = false;
  let nextData = "";

  while (index < data.length) {
    if (state.inPasteEchoActiveRegion) {
      const endIndex = data.indexOf(READLINE_ACTIVE_REGION_END, index);
      if (endIndex === -1) {
        nextData += data.slice(index);
        matched = true;
        break;
      }

      nextData += data.slice(index, endIndex);
      index = endIndex + READLINE_ACTIVE_REGION_END.length;
      state.inPasteEchoActiveRegion = false;
      matched = true;
      continue;
    }

    const startIndex = data.indexOf(READLINE_ACTIVE_REGION_START, index);
    if (startIndex === -1) {
      nextData += data.slice(index);
      break;
    }

    nextData += data.slice(index, startIndex);
    const contentStart = startIndex + READLINE_ACTIVE_REGION_START.length;
    const endIndex = data.indexOf(READLINE_ACTIVE_REGION_END, contentStart);

    if (endIndex === -1) {
      const highlightedContent = data.slice(contentStart);
      if (isExpectedPasteEcho(highlightedContent, state)) {
        nextData += highlightedContent;
        state.inPasteEchoActiveRegion = true;
        matched = true;
      } else {
        nextData += data.slice(startIndex);
      }
      break;
    }

    const highlightedContent = data.slice(contentStart, endIndex);
    if (isExpectedPasteEcho(highlightedContent, state)) {
      nextData += highlightedContent;
      matched = true;
    } else {
      nextData += data.slice(startIndex, endIndex + READLINE_ACTIVE_REGION_END.length);
    }

    index = endIndex + READLINE_ACTIVE_REGION_END.length;
  }

  return { data: nextData, matched };
};

const estimateRows = (text: string, cols: number): number => {
  const width = Math.max(1, cols);
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0);
};

const shouldApplyPasteDisplayFix = (term: PasteTarget, text: string): boolean => {
  if (text.length < LONG_PASTE_MIN_LENGTH) return false;

  const lineCount = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
  const rows = typeof term.rows === "number" && term.rows > 0 ? term.rows : 24;
  const cols = typeof term.cols === "number" && term.cols > 0 ? term.cols : 80;

  return lineCount >= rows - 1 || estimateRows(text, cols) >= rows - 1;
};

export function pasteTextIntoTerminal(
  term: PasteTarget,
  text: string,
  options: PasteOptions = {},
): void {
  if (!text) return;

  if (shouldApplyPasteDisplayFix(term, text)) {
    pasteDisplayStates.set(term, {
      expiresAt: getNow() + PASTE_DISPLAY_FIX_WINDOW_MS,
      clearPending: 0,
      pasteEchoFragments: getPasteEchoFragments(text),
      inPasteEchoActiveRegion: false,
    });
  }

  if (options.scrollOnPaste === false) {
    pasteInputScrollStates.set(term, {
      expiresAt: getNow() + PASTE_INPUT_SCROLL_WINDOW_MS,
      remainingDataVariants: getPasteInputDataVariants(text),
    });
  } else {
    pasteInputScrollStates.delete(term);
  }

  term.paste(text);

  if (!options.scrollOnPaste) return;

  term.scrollToBottom();
  const scheduleFrame =
    options.requestAnimationFrame ??
    (typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : undefined);

  if (scheduleFrame) {
    scheduleFrame(() => {
      term.scrollToBottom();
    });
  }
}

export function shouldSuppressTerminalInputScrollForUserPaste(term: object, data: string): boolean {
  const state = pasteInputScrollStates.get(term);
  if (!isStateActive(state)) {
    pasteInputScrollStates.delete(term);
    return false;
  }

  const matchingIndex = state.remainingDataVariants.findIndex((candidate) => {
    if (candidate === data) return true;
    return candidate.startsWith(data);
  });
  if (matchingIndex === -1) return false;

  const candidate = state.remainingDataVariants[matchingIndex];
  if (candidate.length > data.length) {
    state.remainingDataVariants[matchingIndex] = candidate.slice(data.length);
  } else {
    pasteInputScrollStates.delete(term);
  }
  return true;
}

export function prepareTerminalDataForUserPasteDisplay(term: object, data: string): string {
  const state = pasteDisplayStates.get(term);
  if (!isStateActive(state)) return data;

  const strippedActiveRegion = stripMatchedReadlineActiveRegion(data, state);
  if (strippedActiveRegion.matched) {
    state.clearPending = Math.max(state.clearPending, 3);
    return strippedActiveRegion.data;
  }

  const isPasteEcho = isExpectedPasteEcho(data, state);
  if (isPasteEcho && (data.length > LONG_PASTE_MIN_LENGTH || data.includes("\r"))) {
    state.clearPending = Math.max(state.clearPending, 1);
  }
  return data;
}

export function clearPasteResidualAfterTerminalWrite(term: object): void {
  const state = pasteDisplayStates.get(term);
  if (!isStateActive(state)) return;
  if (state.clearPending <= 0) return;
  if (typeof (term as Partial<Pick<XTerm, "write">>).write !== "function") return;

  // Readline can leave stale cells to the right of the cursor after very long
  // bracketed paste redraws; clear them locally without sending bytes upstream.
  state.clearPending -= 1;
  (term as Pick<XTerm, "write">).write("\x1b[K");
}
