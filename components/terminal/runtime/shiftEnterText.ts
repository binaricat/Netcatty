import type { TerminalSettings } from "../../../domain/models";

export const DEFAULT_SHIFT_ENTER_TEXT = "\\n";

/** Kitty CSI-u encoding for Shift+Enter (keycode 13, modifier shift → 2). */
export const SHIFT_ENTER_CSI_U_SEQUENCE = "\u001b[13;2u";

type ShiftEnterEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
> & {
  isComposing?: boolean;
};

export function decodeTerminalTextEscapes(text: string): string {
  let decoded = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\\" || index >= text.length - 1) {
      decoded += char;
      continue;
    }

    const next = text[index + 1];
    switch (next) {
      case "n":
        decoded += "\n";
        index += 1;
        break;
      case "r":
        decoded += "\r";
        index += 1;
        break;
      case "t":
        decoded += "\t";
        index += 1;
        break;
      case "\\":
        decoded += "\\";
        index += 1;
        break;
      default:
        decoded += char;
        break;
    }
  }

  return decoded;
}

export function shouldSendShiftEnterText(
  event: ShiftEnterEvent,
  settings?: Pick<TerminalSettings, "shiftEnterNewlineEnabled">,
): boolean {
  return (
    settings?.shiftEnterNewlineEnabled !== false &&
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  );
}

export function resolveShiftEnterText(
  settings?: Pick<TerminalSettings, "shiftEnterNewlineText">,
): string {
  const configured = settings?.shiftEnterNewlineText;
  return decodeTerminalTextEscapes(
    typeof configured === "string" ? configured : DEFAULT_SHIFT_ENTER_TEXT,
  );
}

export function isBareShiftEnterLineEnding(text: string): boolean {
  return text === "\n" || text === "\r" || text === "\r\n";
}

/**
 * True when Kitty encoding already keeps Shift+Enter distinct from plain Enter.
 * Non-preserving flag sets (e.g. alternate-key or associated-text alone) still
 * encode Shift+Enter as a bare CR/LF, so the alternate-screen remap must run.
 */
export function doesKittyEncodingPreserveShiftEnter(
  encoded: string | null | undefined,
): boolean {
  return typeof encoded === "string"
    && encoded.length > 0
    && !isBareShiftEnterLineEnding(encoded);
}

export function isShiftEnterLineContinuationText(text: string): boolean {
  return /\\(?:\r\n|\r|\n)$/.test(text);
}

export type ShiftEnterSubmittedInput = {
  text: string;
  lineEnding: "\r\n" | "\r" | "\n";
};

export function getShiftEnterSubmittedInput(
  text: string,
): ShiftEnterSubmittedInput | null {
  if (isShiftEnterLineContinuationText(text)) return null;
  const match = text.match(/^([^\r\n]*)(\r\n|\r|\n)$/);
  if (!match) return null;
  return {
    text: match[1],
    lineEnding: match[2] as ShiftEnterSubmittedInput["lineEnding"],
  };
}
