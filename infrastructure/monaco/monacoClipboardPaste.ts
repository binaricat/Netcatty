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
): MonacoPasteEdit[] {
  if (selections.length === 0) return [];

  const lines = text.split(/\r\n|\n/);
  const distribute = selections.length > 1 && lines.length === selections.length;

  return selections.map((selection, i) => ({
    range: selection,
    text: distribute ? lines[i]! : text,
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
