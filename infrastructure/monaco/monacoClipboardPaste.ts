/**
 * Shared Monaco paste helpers for Electron, where Monaco's built-in
 * clipboardPasteAction often cannot read the OS clipboard.
 */

export type MonacoPasteRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type MonacoPasteEdit = {
  range: MonacoPasteRange;
  text: string;
  forceMoveMarkers: true;
};

/**
 * Build executeEdits payloads matching Monaco multicursorPaste:'spread':
 * when cursor count equals clipboard line count, distribute one line per cursor.
 */
export function buildMonacoPasteEdits(
  text: string,
  selections: readonly MonacoPasteRange[],
  pasteOnNewLine = false,
  multicursorText: readonly string[] | null = null,
): MonacoPasteEdit[] {
  if (selections.length === 0) return [];

  const lines = text.replace(/\r?\n$/, '').split(/\r\n|\n/);
  const distribute = !pasteOnNewLine && selections.length > 1
    && (multicursorText?.length === selections.length || lines.length === selections.length);
  const orderedSelections = distribute
    ? [...selections].sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)
    : selections;

  return orderedSelections.map((selection, i) => ({
    range: pasteOnNewLine && selection.startLineNumber === selection.endLineNumber
      && selection.startColumn === selection.endColumn
      ? {
        startLineNumber: selection.startLineNumber,
        startColumn: 1,
        endLineNumber: selection.startLineNumber,
        endColumn: 1,
      }
      : selection,
    text: distribute ? multicursorText?.[i] ?? lines[i]! : text,
    forceMoveMarkers: true as const,
  }));
}

export type ClipboardTextReaders = {
  readNavigator?: () => Promise<string>;
  readBridge: () => Promise<string>;
};

/**
 * Prefer navigator.clipboard, then Electron bridge.
 * Returns null when both paths fail so callers can fall back to Monaco native paste.
 */
export async function readClipboardTextWithFallbacks(
  readers: ClipboardTextReaders,
): Promise<string | null> {
  if (readers.readNavigator) {
    try {
      return await readers.readNavigator();
    } catch {
      // Fall through to Electron bridge
    }
  }

  try {
    return await readers.readBridge();
  } catch {
    return null;
  }
}
