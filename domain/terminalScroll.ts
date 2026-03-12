import type { TerminalSettings } from "./models";

const hasPrintableTerminalInput = (data: string): boolean => {
  if (data.includes("\x1b")) {
    return false;
  }

  for (const char of data) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint >= 0x20 && codePoint !== 0x7f && codePoint !== 0x1b) {
      return true;
    }
  }
  return false;
};

export const shouldEnableNativeUserInputAutoScroll = (
  settings?: Partial<TerminalSettings> | null,
): boolean => settings?.scrollOnInput ?? true;

export const shouldScrollOnTerminalInput = (
  settings: Partial<TerminalSettings> | null | undefined,
  data: string,
): boolean => {
  const scrollOnInput = settings?.scrollOnInput ?? true;
  const scrollOnKeyPress = settings?.scrollOnKeyPress ?? false;

  if (!scrollOnInput && !scrollOnKeyPress) {
    return false;
  }

  return hasPrintableTerminalInput(data) ? scrollOnInput : scrollOnKeyPress;
};

export const shouldScrollOnTerminalOutput = (
  settings?: Partial<TerminalSettings> | null,
): boolean => settings?.scrollOnOutput ?? false;

export const shouldScrollOnTerminalPaste = (
  settings?: Partial<TerminalSettings> | null,
): boolean => settings?.scrollOnPaste ?? true;
