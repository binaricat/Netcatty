/**
 * Pure logic for the multi-line paste confirmation dialog (#3398).
 *
 * Network-device CLIs (Cisco IOS, Huawei VRP, H3C Comware) do not implement
 * bracketed paste, so a multi-line paste is executed line-by-line with no
 * chance to review it. This module decides when a paste needs confirmation
 * and how the clipboard text is summarized for the dialog.
 */

export type MultilinePasteConfirmAction = "send" | "line-by-line" | "cancel";

/** Default threshold: any paste of 2+ lines asks for confirmation. */
export const MULTILINE_PASTE_CONFIRM_MIN_LINES_DEFAULT = 2;
export const MULTILINE_PASTE_CONFIRM_MIN_LINES_MIN = 1;
export const MULTILINE_PASTE_CONFIRM_MIN_LINES_MAX = 1000;

export interface MultilinePasteInfo {
  /** Number of lines the paste will submit (trailing newline not counted). */
  lineCount: number;
  /** Total character count of the clipboard text. */
  charCount: number;
}

/** Normalize CRLF / CR line endings to LF for line counting and preview. */
export const normalizeMultilinePasteText = (text: string): string =>
  String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const normalizeMultilinePasteConfirmMinLines = (
  value?: number | null,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MULTILINE_PASTE_CONFIRM_MIN_LINES_DEFAULT;
  }
  const rounded = Math.round(value);
  if (rounded < MULTILINE_PASTE_CONFIRM_MIN_LINES_MIN) {
    return MULTILINE_PASTE_CONFIRM_MIN_LINES_MIN;
  }
  if (rounded > MULTILINE_PASTE_CONFIRM_MIN_LINES_MAX) {
    return MULTILINE_PASTE_CONFIRM_MIN_LINES_MAX;
  }
  return rounded;
};

export const getMultilinePasteInfo = (text: string): MultilinePasteInfo => {
  const normalized = normalizeMultilinePasteText(text);
  const lines = normalized.split("\n");
  // A single trailing newline is just the line terminator, not an extra line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return {
    lineCount: lines.length,
    charCount: text.length,
  };
};

export const shouldConfirmMultilinePaste = (
  text: string,
  options?: { minLines?: number | null },
): boolean => {
  const minLines = normalizeMultilinePasteConfirmMinLines(
    options?.minLines ?? MULTILINE_PASTE_CONFIRM_MIN_LINES_DEFAULT,
  );
  return getMultilinePasteInfo(text).lineCount >= minLines;
};
