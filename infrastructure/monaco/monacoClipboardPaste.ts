/**
 * Shared Monaco paste helpers for Electron, where Monaco's built-in
 * clipboardPasteAction often cannot read the OS clipboard.
 *
 * Whole-line / multicursor copy metadata is shared across Monaco editor
 * surfaces (ScriptCodeEditor, TextEditorPane) so paste can restore
 * pasteOnNewLine and multicursor boundaries after an async clipboard read.
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

export type MonacoClipboardSelection = MonacoPasteRange & {
  isEmpty(): boolean;
};

export type MonacoClipboardModel = {
  getLineContent(lineNumber: number): string;
  getValueInRange(range: MonacoPasteRange): string;
};

export type MonacoClipboardMetadataEditor = {
  hasTextFocus(): boolean;
  getSelections(): readonly MonacoClipboardSelection[] | null;
  getModel(): MonacoClipboardModel | null;
  getContainerDomNode(): HTMLElement;
};

let copiedWholeLineText: string | null = null;
let copiedMulticursor: { text: string; values: readonly string[] } | null = null;

/**
 * Record whole-line / multicursor copy shape from a Monaco copy or cut event.
 */
export function captureMonacoClipboardMetadata(input: {
  copiedText: string | null;
  selections: readonly MonacoClipboardSelection[] | null | undefined;
  model: MonacoClipboardModel | null;
}): void {
  const { copiedText, selections, model } = input;
  copiedWholeLineText = selections?.length === 1 && selections[0]?.isEmpty()
    ? copiedText
    : null;
  const orderedSelections = selections?.toSorted((a, b) => (
    a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn
  ));
  copiedMulticursor = copiedText && orderedSelections && orderedSelections.length > 1 && model
    ? {
      text: copiedText,
      values: orderedSelections
        .filter((selection, index) => !selection.isEmpty()
          || index === 0
          || orderedSelections[index - 1]?.startLineNumber !== selection.startLineNumber)
        .map((selection) => selection.isEmpty()
          ? model.getLineContent(selection.startLineNumber)
          : model.getValueInRange(selection)),
    }
    : null;
}

/**
 * Resolve paste behavior from the last Monaco-wide copy/cut metadata.
 */
export function resolveMonacoPasteClipboardMetadata(text: string): {
  pasteOnNewLine: boolean;
  multicursorText: readonly string[] | null;
} {
  return {
    pasteOnNewLine: copiedWholeLineText === text && text.endsWith('\n'),
    multicursorText: copiedMulticursor?.text === text
      ? copiedMulticursor.values
      : null,
  };
}

/**
 * Listen for copy/cut on a Monaco editor and update the shared metadata store.
 */
export function attachMonacoClipboardMetadataCapture(
  editor: MonacoClipboardMetadataEditor,
): { dispose: () => void } {
  const captureClipboardMetadata = (event: ClipboardEvent) => {
    if (!editor.hasTextFocus()) return;
    captureMonacoClipboardMetadata({
      copiedText: event.clipboardData?.getData('text/plain') || null,
      selections: editor.getSelections(),
      model: editor.getModel(),
    });
  };
  const node = editor.getContainerDomNode();
  node.addEventListener('copy', captureClipboardMetadata);
  node.addEventListener('cut', captureClipboardMetadata);
  return {
    dispose: () => {
      node.removeEventListener('copy', captureClipboardMetadata);
      node.removeEventListener('cut', captureClipboardMetadata);
    },
  };
}

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
  const hasMulticursorText = multicursorText?.length === selections.length;
  const distribute = !pasteOnNewLine && selections.length > 1
    && (hasMulticursorText || lines.length === selections.length);
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
    text: distribute ? (hasMulticursorText ? multicursorText[i]! : lines[i]!) : text,
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
