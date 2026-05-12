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
};

const pasteDisplayStates = new WeakMap<object, PasteDisplayState>();
const LONG_PASTE_MIN_LENGTH = 200;
const PASTE_DISPLAY_FIX_WINDOW_MS = 4000;
const READLINE_ACTIVE_REGION_MARKERS = ["\x1b[7m", "\x1b[27m"] as const;

const getNow = () => Date.now();

const isStateActive = (state: PasteDisplayState | undefined): state is PasteDisplayState =>
  !!state && state.expiresAt > getNow();

const hasReadlineActiveRegion = (data: string): boolean =>
  READLINE_ACTIVE_REGION_MARKERS.some((marker) => data.includes(marker));

const stripReadlineActiveRegion = (data: string): string =>
  READLINE_ACTIVE_REGION_MARKERS.reduce(
    (nextData, marker) => nextData.split(marker).join(""),
    data,
  );

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
      clearPending: 1,
    });
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

export function prepareTerminalDataForUserPasteDisplay(term: object, data: string): string {
  const state = pasteDisplayStates.get(term);
  if (!isStateActive(state)) return data;

  if (hasReadlineActiveRegion(data)) {
    state.clearPending = Math.max(state.clearPending, 3);
    return stripReadlineActiveRegion(data);
  }

  if (data.length > LONG_PASTE_MIN_LENGTH || data.includes("\r")) {
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
