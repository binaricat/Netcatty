import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMonacoPasteEdits,
  MONACO_CLIPBOARD_PASTE_COMMAND_ID,
  readClipboardTextWithFallbacks,
  registerBridgePasteForEditor,
  resetBridgePasteRegistryForTests,
  type MonacoPasteCommandApi,
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

function createMockMonacoPasteApi(editors: {
  id: string;
  focused: boolean;
  execPaste?: () => void;
}[]): {
  api: MonacoPasteCommandApi;
  handlers: Array<(...args: unknown[]) => void>;
  disposeCalls: number;
} {
  const handlers: Array<(...args: unknown[]) => void> = [];
  const state = { disposeCalls: 0 };
  const api: MonacoPasteCommandApi = {
    getEditors: () => editors.map((editor) => ({
      getId: () => editor.id,
      hasTextFocus: () => editor.focused,
      getContainerDomNode: () => ({
        ownerDocument: {
          execCommand: (command: string) => {
            assert.equal(command, 'paste');
            editor.execPaste?.();
            return true;
          },
        },
      }) as HTMLElement,
    })),
    registerCommand: (id, handler) => {
      assert.equal(id, MONACO_CLIPBOARD_PASTE_COMMAND_ID);
      handlers.push(handler);
      return {
        dispose: () => {
          state.disposeCalls += 1;
        },
      };
    },
  };
  return {
    api,
    handlers,
    get disposeCalls() {
      return state.disposeCalls;
    },
  };
}

test('registerBridgePasteForEditor routes built-in Paste to the focused editor handler', () => {
  resetBridgePasteRegistryForTests();
  const mock = createMockMonacoPasteApi([
    { id: 'editor-a', focused: true },
    { id: 'editor-b', focused: false },
  ]);
  let pastedA = 0;
  let pastedB = 0;

  const disposeA = registerBridgePasteForEditor(mock.api, 'editor-a', () => {
    pastedA += 1;
  });
  registerBridgePasteForEditor(mock.api, 'editor-b', () => {
    pastedB += 1;
  });

  assert.equal(mock.handlers.length, 1);
  mock.handlers[0]!();
  assert.equal(pastedA, 1);
  assert.equal(pastedB, 0);

  disposeA.dispose();
  assert.equal(mock.disposeCalls, 0);
  resetBridgePasteRegistryForTests();
});

test('registerBridgePasteForEditor falls back to execCommand for unregistered editors', () => {
  resetBridgePasteRegistryForTests();
  let execPasteCount = 0;
  const mock = createMockMonacoPasteApi([
    { id: 'other', focused: true, execPaste: () => { execPasteCount += 1; } },
  ]);

  const dispose = registerBridgePasteForEditor(mock.api, 'script-editor', () => {
    assert.fail('script handler should not run');
  });

  mock.handlers[0]!();
  assert.equal(execPasteCount, 1);

  dispose.dispose();
  assert.equal(mock.disposeCalls, 1);
  resetBridgePasteRegistryForTests();
});

test('registerBridgePasteForEditor disposes shared command when last editor unregisters', () => {
  resetBridgePasteRegistryForTests();
  const mock = createMockMonacoPasteApi([{ id: 'editor-a', focused: true }]);
  const first = registerBridgePasteForEditor(mock.api, 'editor-a', () => {});
  const second = registerBridgePasteForEditor(mock.api, 'editor-b', () => {});

  assert.equal(mock.handlers.length, 1);
  first.dispose();
  assert.equal(mock.disposeCalls, 0);
  second.dispose();
  assert.equal(mock.disposeCalls, 1);
  resetBridgePasteRegistryForTests();
});
