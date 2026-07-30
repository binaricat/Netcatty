import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMonacoPasteEdits,
  readClipboardTextWithFallbacks,
} from './monacoClipboardPaste.ts';

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

test('buildMonacoPasteEdits spreads one line per cursor when counts match', () => {
  const edits = buildMonacoPasteEdits('one\ntwo', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  ]);
  assert.equal(edits.length, 2);
  assert.equal(edits[0]?.text, 'one');
  assert.equal(edits[1]?.text, 'two');
});

test('buildMonacoPasteEdits does not spread when line and cursor counts differ', () => {
  const edits = buildMonacoPasteEdits('only-one-line', [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  ]);
  assert.equal(edits[0]?.text, 'only-one-line');
  assert.equal(edits[1]?.text, 'only-one-line');
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
