import type { IBuffer, Terminal as XTerm } from "@xterm/xterm";

export type TerminalTextRange = {
  startLine: number;
  endLine: number;
};

type TerminalBufferTextSource = Pick<XTerm, "buffer" | "cols">;

export function readActiveTerminalBufferTextRange(
  term: TerminalBufferTextSource,
  range: TerminalTextRange,
): string {
  const startLine = Math.max(0, Math.floor(range.startLine));
  const endLine = Math.max(-1, Math.floor(range.endLine));
  if (endLine < startLine) return "";

  return readTerminalBufferTextRange(term.buffer.active, {
    ...range,
    cols: term.cols,
  });
}

export function readTerminalBufferTextRange(
  buffer: Pick<IBuffer, "getLine">,
  range: TerminalTextRange & { cols?: number },
): string {
  const startLine = Math.max(0, Math.floor(range.startLine));
  const endLine = Math.max(-1, Math.floor(range.endLine));
  if (endLine < startLine) return "";

  const cols = typeof range.cols === "number" && Number.isFinite(range.cols)
    ? Math.max(0, Math.floor(range.cols))
    : undefined;

  const lines: string[] = [];
  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    lines.push(line?.translateToString(true, 0, cols) ?? "");
  }
  return lines.join("\n");
}
