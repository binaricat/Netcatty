export function formatTelnetLocalEcho(data: string): string {
  let output = "";
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === "\r") {
      output += "\r\n";
      if (data[i + 1] === "\n") i += 1;
    } else if (ch === "\n") {
      output += "\r\n";
    } else if (ch === "\x1b") {
      if (data[i + 1] === "[" || data[i + 1] === "O") {
        i += 1;
        while (i + 1 < data.length) {
          i += 1;
          const code = data.charCodeAt(i);
          if (code >= 0x40 && code <= 0x7e) break;
        }
      } else if (i + 1 < data.length) {
        i += 1;
      }
    } else if (ch === "\x7f" || ch === "\b") {
      output += "\b \b";
    } else if (ch === "\x03") {
      output += "^C";
    } else if (ch >= " ") {
      output += ch;
    }
  }
  return output;
}
