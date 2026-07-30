import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachMonacoClipboardMetadataCapture,
  buildMonacoPasteEdits,
  captureMonacoClipboardMetadata,
  readClipboardTextWithFallbacks,
  resolveMonacoPasteClipboardMetadata,
} from './monacoClipboardPaste.ts';

function selection(
  startLineNumber: number,
  startColumn: number,
  endLineNumber = startLineNumber,
  endColumn = startColumn,
) {
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    isEmpty: () => startLineNumber === endLineNumber && startColumn === endColumn,
  };
}

test('buildMonacoPasteEdits pastes full text at a single cursor', () => {
  const edits = buildMonacoPasteEdits('hello\nworld', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  ]);
  assert.deepEqual(edits, [
    {
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'hello\nworld',
      forceMoveMarkers: true,
    },
  ]);
});

test('buildMonacoPasteEdits inserts a copied whole line at column one', () => {
  const edits = buildMonacoPasteEdits('copied line\n', [
    { startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 },
  ], true);
  assert.deepEqual(edits[0]?.range, {
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 2,
    endColumn: 1,
  });
});

test('buildMonacoPasteEdits preserves non-empty selections during whole-line paste', () => {
  const edits = buildMonacoPasteEdits('copied line\n', [
    { startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 },
    { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 },
  ], true);
  assert.equal(edits[0]?.range.startColumn, 1);
  assert.deepEqual(edits[1]?.range, {
    startLineNumber: 3,
    startColumn: 2,
    endLineNumber: 3,
    endColumn: 5,
  });
});

test('buildMonacoPasteEdits spreads one line per cursor when counts match', () => {
  const edits = buildMonacoPasteEdits('one\ntwo', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  ]);
  assert.equal(edits.length, 2);
  assert.equal(edits[0]?.text, 'one');
  assert.equal(edits[1]?.text, 'two');
});

test('buildMonacoPasteEdits ignores one trailing newline when spreading', () => {
  const edits = buildMonacoPasteEdits('one\ntwo\n', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  ]);
  assert.equal(edits[0]?.text, 'one');
  assert.equal(edits[1]?.text, 'two');
});

test('buildMonacoPasteEdits assigns spread lines in document order', () => {
  const edits = buildMonacoPasteEdits('one\ntwo', [
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  ]);
  assert.equal(edits[0]?.range.startLineNumber, 1);
  assert.equal(edits[0]?.text, 'one');
  assert.equal(edits[1]?.range.startLineNumber, 2);
  assert.equal(edits[1]?.text, 'two');
});

test('buildMonacoPasteEdits preserves multicursor selection boundaries', () => {
  const edits = buildMonacoPasteEdits('a\nb\nc', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  ], false, ['a\nb', 'c']);
  assert.equal(edits[0]?.text, 'a\nb');
  assert.equal(edits[1]?.text, 'c');
});

test('buildMonacoPasteEdits does not spread when line and cursor counts differ', () => {
  const edits = buildMonacoPasteEdits('only-one-line', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  ]);
  assert.equal(edits[0]?.text, 'only-one-line');
  assert.equal(edits[1]?.text, 'only-one-line');
});

test('buildMonacoPasteEdits preserves trailing newlines when not spreading', () => {
  const edits = buildMonacoPasteEdits('one\ntwo\n', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  ]);
  assert.equal(edits[0]?.text, 'one\ntwo\n');
});

test('buildMonacoPasteEdits returns empty when there are no selections', () => {
  assert.deepEqual(buildMonacoPasteEdits('text', []), []);
});

test('readClipboardTextWithFallbacks prefers navigator clipboard', async () => {
  const text = await readClipboardTextWithFallbacks({
    readNavigator: async () => 'from-navigator',
    readBridge: async () => {
      throw new Error('bridge should not run');
    },
  });
  assert.equal(text, 'from-navigator');
});

test('readClipboardTextWithFallbacks uses bridge when navigator fails', async () => {
  const text = await readClipboardTextWithFallbacks({
    readNavigator: async () => {
      throw new Error('denied');
    },
    readBridge: async () => 'from-bridge',
  });
  assert.equal(text, 'from-bridge');
});

test('readClipboardTextWithFallbacks returns null when both paths fail', async () => {
  const text = await readClipboardTextWithFallbacks({
    readNavigator: async () => {
      throw new Error('denied');
    },
    readBridge: async () => {
      throw new Error('unavailable');
    },
  });
  assert.equal(text, null);
});

test('captureMonacoClipboardMetadata records whole-line copies for pasteOnNewLine', () => {
  captureMonacoClipboardMetadata({
    copiedText: 'copied line\n',
    selections: [selection(3, 1)],
    model: {
      getLineContent: () => 'copied line',
      getValueInRange: () => '',
    },
  });
  assert.deepEqual(resolveMonacoPasteClipboardMetadata('copied line\n'), {
    pasteOnNewLine: true,
    multicursorText: null,
  });
});

test('captureMonacoClipboardMetadata records multicursor copy boundaries', () => {
  captureMonacoClipboardMetadata({
    copiedText: 'a\nb\nc',
    selections: [
      selection(2, 1, 2, 2),
      selection(1, 1, 1, 4),
    ],
    model: {
      getLineContent: () => '',
      getValueInRange: (range) => (
        range.startLineNumber === 1 ? 'a\nb' : 'c'
      ),
    },
  });
  assert.deepEqual(resolveMonacoPasteClipboardMetadata('a\nb\nc'), {
    pasteOnNewLine: false,
    multicursorText: ['a\nb', 'c'],
  });
});

test('captureMonacoClipboardMetadata clears stale metadata for ordinary selection copies', () => {
  captureMonacoClipboardMetadata({
    copiedText: 'copied line\n',
    selections: [selection(1, 1)],
    model: {
      getLineContent: () => 'copied line',
      getValueInRange: () => '',
    },
  });
  captureMonacoClipboardMetadata({
    copiedText: 'plain',
    selections: [selection(1, 1, 1, 6)],
    model: {
      getLineContent: () => 'plain',
      getValueInRange: () => 'plain',
    },
  });
  assert.deepEqual(resolveMonacoPasteClipboardMetadata('plain'), {
    pasteOnNewLine: false,
    multicursorText: null,
  });
});

test('attachMonacoClipboardMetadataCapture listens for copy and cut while focused', () => {
  const listeners = new Map<string, EventListener>();
  const node = {
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const editor = {
    hasTextFocus: () => true,
    getSelections: () => [selection(1, 1)],
    getModel: () => ({
      getLineContent: () => 'line',
      getValueInRange: () => '',
    }),
    getContainerDomNode: () => node as unknown as HTMLElement,
  };

  const disposable = attachMonacoClipboardMetadataCapture(editor);
  assert.equal(listeners.has('copy'), true);
  assert.equal(listeners.has('cut'), true);

  listeners.get('copy')?.({
    clipboardData: { getData: () => 'line\n' },
  } as unknown as ClipboardEvent);
  assert.equal(resolveMonacoPasteClipboardMetadata('line\n').pasteOnNewLine, true);

  disposable.dispose();
  assert.equal(listeners.size, 0);
});
