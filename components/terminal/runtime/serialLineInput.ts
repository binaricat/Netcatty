import { getLastChar, removeLastChar } from '../../../domain/serialCharMetrics';
import { stringCellWidth } from '../autocomplete/terminalStringCellWidth';
import type { Terminal as XTerm } from '@xterm/xterm';

type StringRef = {
  current: string;
};

type SerialLineModeInputOptions = {
  bufferRef: StringRef;
  localEcho?: boolean;
  writeToSession: (data: string) => void;
  writeToTerminal: (data: string) => void;
  /** xterm instance for grapheme-accurate width via UnicodeService. */
  term?: XTerm | null;
};

const submitLine = ({
  bufferRef,
  localEcho,
  writeToSession,
  writeToTerminal,
}: SerialLineModeInputOptions) => {
  const line = `${bufferRef.current}\r`;
  writeToSession(line);
  bufferRef.current = "";
  if (localEcho) writeToTerminal("\r\n");
};

const appendText = (
  text: string,
  { bufferRef, localEcho, writeToTerminal }: SerialLineModeInputOptions,
) => {
  if (!text) return;
  bufferRef.current += text;
  if (localEcho) writeToTerminal(text);
};

const clearLine = ({
  bufferRef,
  localEcho,
  writeToTerminal,
}: SerialLineModeInputOptions) => {
  if (localEcho && bufferRef.current.length > 0) {
    writeToTerminal("\b \b".repeat(bufferRef.current.length));
  }
  bufferRef.current = "";
};

export function handleSerialLineModeInput(
  data: string,
  options: SerialLineModeInputOptions,
): void {
  if (data === "\r" || data === "\n") {
    submitLine(options);
    return;
  }

  if (data === "\x7f" || data === "\b") {
    if (options.bufferRef.current.length > 0) {
      const lastChar = getLastChar(options.bufferRef.current);
      const cells = stringCellWidth(lastChar, options.term);
      options.bufferRef.current = removeLastChar(options.bufferRef.current);
      if (options.localEcho) options.writeToTerminal("\b \b".repeat(cells));
    }
    return;
  }

  if (data === "\x03") {
    options.bufferRef.current = "";
    options.writeToSession(data);
    if (options.localEcho) options.writeToTerminal("^C\r\n");
    return;
  }

  if (data === "\x15") {
    clearLine(options);
    return;
  }

  const normalizedData = data.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  if (normalizedData.includes("\r")) {
    const parts = normalizedData.split("\r");
    parts.forEach((part, index) => {
      appendText(part, options);
      if (index < parts.length - 1) submitLine(options);
    });
    return;
  }

  if (data.charCodeAt(0) >= 32 || data.length > 1) {
    appendText(data, options);
  }
}
