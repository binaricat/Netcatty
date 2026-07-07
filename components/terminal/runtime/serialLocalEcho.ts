function normalizeSerialLocalEchoLineEndings(data: string): string {
  let output = "";
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === "\r") {
      output += "\r\n";
      if (data[i + 1] === "\n") i += 1;
    } else if (ch === "\n") {
      output += "\r\n";
    } else {
      output += ch;
    }
  }
  return output;
}

export function formatSerialLocalEcho(data: string): string {
  if (!data) return "";
  if (data === "\x7f" || data === "\b") return "\b \b";
  if (data === "\x03") return "^C";
  if (data === "\r" || data === "\n" || data.charCodeAt(0) >= 32 || data.length > 1) {
    return normalizeSerialLocalEchoLineEndings(data);
  }
  return "";
}
