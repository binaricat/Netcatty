import type { TerminalSettings } from "../../../domain/models";

export const DEFAULT_SHIFT_ENTER_TEXT = "\\n";

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
