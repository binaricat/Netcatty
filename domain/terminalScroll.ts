import type { TerminalSettings } from "./models";

type TerminalScrollTarget = {
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  scrollToBottom: () => void;
};

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

export const scrollTerminalToBottomIfNeeded = (
  terminal: TerminalScrollTarget,
): boolean => {
  const { baseY, viewportY } = terminal.buffer.active;
  if (viewportY >= baseY) {
    return false;
  }

  terminal.scrollToBottom();
  return true;
};

export const scrollTerminalToBottomAfterInputIfEnabled = (
  terminal: TerminalScrollTarget,
  settings: Partial<TerminalSettings> | null | undefined,
  data: string,
): boolean => {
  if (!shouldScrollOnTerminalInput(settings, data)) {
    return false;
  }

  return scrollTerminalToBottomIfNeeded(terminal);
};
