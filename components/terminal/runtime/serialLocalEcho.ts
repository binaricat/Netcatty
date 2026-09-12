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

/**
 * Format a terminal input string as local echo for serial connections.
 *
 * When `backspaceCells` is provided it overrides the default 1-cell erase
 * for backspace.  CJK ideographs occupy 2 terminal cells, so the caller
 * should pass 2 when the character being deleted is wide — otherwise the
 * local echo only erases half the glyph and leaves a hidden remnant.
 */
export function formatSerialLocalEcho(data: string, backspaceCells?: number): string {
  if (!data) return "";
  if (data === "\x7f" || data === "\b") return "\b \b".repeat(backspaceCells ?? 1);
  if (data === "\x03") return "^C";
  if (data === "\r" || data === "\n" || data.charCodeAt(0) >= 32 || data.length > 1) {
    return normalizeSerialLocalEchoLineEndings(data);
  }
  return "";
}
