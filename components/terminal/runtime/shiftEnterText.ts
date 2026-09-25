import type { TerminalSettings } from "../../../domain/models";

export const DEFAULT_SHIFT_ENTER_TEXT = "\\n";

/** Kitty CSI-u encoding for Shift+Enter (keycode 13, modifier shift → 2). */
export const SHIFT_ENTER_CSI_U_SEQUENCE = "\u001b[13;2u";

// Structural subset shared by DOM KeyboardEvent and KittyKeyboardEvent, whose
// type and modifier fields are optional.
type ShiftEnterEvent = {
  type?: string;
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
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
      case "e":
        decoded += "\u001b";
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
    event.shiftKey === true &&
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

/**
 * Text to send instead of the native Win32 INPUT_RECORD for Shift+Enter, or
 * null when the native record should be kept. Only the explicit
 * shiftEnterForceText opt-out overrides the ConPTY Win32 hand-off, and an
 * empty configured text never claims the key.
 */
export function resolveWin32ForcedShiftEnterText(
  event: ShiftEnterEvent,
  settings?: Pick<
    TerminalSettings,
    "shiftEnterNewlineEnabled" | "shiftEnterNewlineText" | "shiftEnterForceText"
  >,
): string | null {
  if (settings?.shiftEnterForceText !== true) return null;
  if (!shouldSendShiftEnterText(event, settings)) return null;
  return resolveShiftEnterText(settings) || null;
}

/**
 * Whether a local Shift+Enter keydown should be claimed for the configured
 * text. Under ConPTY Win32 input mode the native record wins unless the user
 * opted out with shiftEnterForceText; elsewhere the text is used only when the
 * negotiated Kitty encoding would collapse the chord to a bare CR/LF, so the
 * Win32 opt-out can never override a Kitty encoding that preserves it.
 */
export function shouldClaimShiftEnterForText(
  event: ShiftEnterEvent,
  settings: Pick<
    TerminalSettings,
    "shiftEnterNewlineEnabled" | "shiftEnterForceText"
  > | undefined,
  mode: { win32InputMode: boolean; kittySequenceForKeyDown: string | null },
): boolean {
  if (!shouldSendShiftEnterText(event, settings)) return false;
  return mode.win32InputMode
    ? settings?.shiftEnterForceText === true
    : !doesKittyEncodingPreserveShiftEnter(mode.kittySequenceForKeyDown);
}
