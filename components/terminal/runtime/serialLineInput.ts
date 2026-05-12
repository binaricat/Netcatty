type StringRef = {
  current: string;
};

type SerialLineModeInputOptions = {
  bufferRef: StringRef;
  localEcho?: boolean;
  writeToSession: (data: string) => void;
  writeToTerminal: (data: string) => void;
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
      options.bufferRef.current = options.bufferRef.current.slice(0, -1);
      if (options.localEcho) options.writeToTerminal("\b \b");
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
