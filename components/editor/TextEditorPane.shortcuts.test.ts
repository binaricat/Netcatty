import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as Monaco from 'monaco-editor';
const require = createRequire(import.meta.url);
const { ContextKeyExpr } = require('monaco-editor/esm/vs/platform/contextkey/common/contextkey.js');
const { KeybindingResolver } = require('monaco-editor/esm/vs/platform/keybinding/common/keybindingResolver.js');
import { pasteForMonacoEditorCommand } from '../../infrastructure/monaco/monacoClipboardPaste.ts';
import {
  bindTextEditorActions,
  registerTextEditorAction,
  type TextEditorActionConfig,
} from './TextEditorPane.tsx';

type RegisteredBinding = {
  command: string;
  commandArgs: undefined;
  chords: string[];
  when: ReturnType<typeof ContextKeyExpr.deserialize>;
  isDefault: boolean;
  bubble: boolean;
};

function createStandaloneActionRegistry() {
  const commands = new Map<string, () => void>();
  const bindings: RegisteredBinding[] = [];

  function createEditor(editorId: string) {
    const disposeListeners = new Set<() => void>();
    const actionDisposals: string[] = [];
    let onDidDisposeDisposals = 0;

    const editor = {
      getId: () => editorId,
      addAction(descriptor: Monaco.editor.IActionDescriptor): Monaco.IDisposable {
        assert.equal(descriptor.contextMenuGroupId, undefined, 'contextMenuGroupId must be omitted');
        assert.ok(descriptor.label.trim().length > 0, 'action must provide a non-empty label');
        const uniqueId = `${editorId}:${descriptor.id}`;
        const precondition = ContextKeyExpr.and(
          ContextKeyExpr.equals('editorId', editorId),
          ContextKeyExpr.deserialize(descriptor.precondition),
        );
        const keybindingsWhen = ContextKeyExpr.and(
          precondition,
          ContextKeyExpr.deserialize(descriptor.keybindingContext),
        );
        const run = () => {
          void descriptor.run(editor as unknown as Monaco.editor.ICodeEditor);
        };
        commands.set(uniqueId, run);
        const added: RegisteredBinding[] = [];
        for (const kb of descriptor.keybindings ?? []) {
          const entry: RegisteredBinding = {
            command: uniqueId,
            commandArgs: undefined,
            chords: [String(kb)],
            when: keybindingsWhen,
            isDefault: false,
            bubble: false,
          };
          bindings.push(entry);
          added.push(entry);
        }
        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            actionDisposals.push(descriptor.id);
            commands.delete(uniqueId);
            for (const entry of added) {
              const idx = bindings.indexOf(entry);
              if (idx >= 0) bindings.splice(idx, 1);
            }
          },
        };
      },
      onDidDispose(listener: () => void): Monaco.IDisposable {
        disposeListeners.add(listener);
        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            onDidDisposeDisposals += 1;
            disposeListeners.delete(listener);
          },
        };
      },
      triggerDispose() {
        for (const listener of [...disposeListeners]) {
          listener();
        }
      },
      get stats() {
        return {
          actionDisposals: [...actionDisposals],
          onDidDisposeDisposals,
          activeDisposeListeners: disposeListeners.size,
        };
      },
    };

    return editor;
  }

  function press(editorId: string | undefined, keybinding: number) {
    const resolver = new KeybindingResolver([], bindings, () => {});
    const result = resolver.resolve(
      { getValue: (key: string) => (key === 'editorId' ? editorId : undefined) },
      [],
      String(keybinding),
    ) as { kind: number; commandId?: string };
    if (result.kind === 2) commands.get(result.commandId!)!();
    return result.kind;
  }

  return { commands, bindings, createEditor, press };
}

test('save, close, find and paste actions resolve to the focused editor and unregister cleanly on dispose', () => {
  const registry = createStandaloneActionRegistry();
  const calls: string[] = [];
  const actions: Array<{ id: string; label: string; name: string }> = [
    { id: 'netcatty.textEditor.save', label: 'Save File', name: 'save' },
    { id: 'netcatty.textEditor.closeTab', label: 'Close Editor Tab', name: 'close' },
    { id: 'netcatty.textEditor.find', label: 'Find', name: 'find' },
    { id: 'netcatty.textEditor.paste', label: 'Paste', name: 'paste' },
  ];

  const editors = ['vs.editor.ICodeEditor:beta', 'vs.editor.ICodeEditor:alpha'].map((editorId) => {
    const editor = registry.createEditor(editorId);
    const binding = bindTextEditorActions(
      editor,
      actions.map((action, keybinding): TextEditorActionConfig => ({
        id: action.id,
        label: action.label,
        keybinding,
        run: () => {
          calls.push(`${editorId}:${action.name}`);
        },
      })),
    );
    return { editorId, editor, binding };
  });

  for (const editorId of ['vs.editor.ICodeEditor:beta', 'vs.editor.ICodeEditor:alpha', 'vs.editor.ICodeEditor:beta']) {
    actions.forEach((action, keybinding) => {
      const before = calls.length;
      assert.equal(registry.press(editorId, keybinding), 2);
      assert.deepEqual(calls.slice(before), [`${editorId}:${action.name}`]);
    });
  }

  const before = calls.length;
  actions.forEach((_, keybinding) => assert.equal(registry.press(undefined, keybinding), 0));
  assert.equal(calls.length, before, 'no hidden editor handles keys outside editor context');

  // Disposing alpha via editor.onDidDispose removes all 4 commands & keybindings from the registry
  assert.equal(registry.commands.size, 8);
  assert.equal(registry.bindings.length, 8);
  editors[1]!.editor.triggerDispose();
  assert.equal(registry.commands.size, 4);
  assert.equal(registry.bindings.length, 4);
  assert.equal(editors[1]!.editor.stats.actionDisposals.length, 4);
  assert.equal(editors[1]!.editor.stats.onDidDisposeDisposals, 1);
  assert.equal(editors[1]!.editor.stats.activeDisposeListeners, 0);

  // Calling React unmount cleanup afterward is an idempotent no-op
  editors[1]!.binding.dispose();
  assert.equal(editors[1]!.editor.stats.actionDisposals.length, 4);
  assert.equal(editors[1]!.editor.stats.onDidDisposeDisposals, 1);

  // Beta still resolves all 4 shortcuts until React unmount disposes it
  actions.forEach((action, keybinding) => {
    const start = calls.length;
    assert.equal(registry.press('vs.editor.ICodeEditor:beta', keybinding), 2);
    assert.deepEqual(calls.slice(start), [`vs.editor.ICodeEditor:beta:${action.name}`]);
  });

  editors[0]!.binding.dispose();
  assert.equal(registry.commands.size, 0, 'all commands must be unregistered after unmount');
  assert.equal(registry.bindings.length, 0, 'all keybindings must be unregistered after unmount');
  assert.equal(editors[0]!.editor.stats.actionDisposals.length, 4);
  assert.equal(editors[0]!.editor.stats.onDidDisposeDisposals, 1);
  assert.equal(editors[0]!.editor.stats.activeDisposeListeners, 0);
});

test('Ctrl/Cmd+V paste action still pastes into the Monaco Find/Replace widget when focused', async () => {
  const registry = createStandaloneActionRegistry();
  const editor = registry.createEditor('vs.editor.ICodeEditor:find-paste');
  let bodyPasteCount = 0;
  const findInput = {
    value: 'abc',
    selectionStart: 3,
    selectionEnd: 3,
    closest: (selector: string) => (selector === '.find-widget' ? {} : null),
    focus() {},
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };

  let pastePromise: Promise<void> | null = null;
  const disposable = registerTextEditorAction(editor, {
    id: 'netcatty.textEditor.paste',
    label: 'Paste',
    keybinding: 42,
    run: () => {
      pastePromise = pasteForMonacoEditorCommand({
        activeElement: findInput,
        readClipboardText: async () => 'XYZ',
        pasteIntoEditor: () => {
          bodyPasteCount += 1;
        },
      });
    },
  });

  assert.equal(registry.press('vs.editor.ICodeEditor:find-paste', 42), 2);
  await pastePromise;
  assert.equal(findInput.value, 'abcXYZ');
  assert.equal(bodyPasteCount, 0);

  disposable.dispose();
  assert.equal(registry.commands.size, 0);
  assert.equal(registry.bindings.length, 0);
});

test('repeated mount/unmount cycles leak zero Monaco commands or keybindings', () => {
  const registry = createStandaloneActionRegistry();
  let cleanupCalls = 0;

  for (let i = 0; i < 20; i += 1) {
    const editor = registry.createEditor(`vs.editor.ICodeEditor:cycle-${i}`);
    const binding = bindTextEditorActions(
      editor,
      [
        { id: 'netcatty.textEditor.save', label: 'Save File', keybinding: 1, run: () => {} },
        { id: 'netcatty.textEditor.closeTab', label: 'Close Editor Tab', keybinding: 2, run: () => {} },
        { id: 'netcatty.textEditor.find', label: 'Find', keybinding: 3, run: () => {} },
        { id: 'netcatty.textEditor.paste', label: 'Paste', keybinding: 4, run: () => {} },
      ],
      () => {
        cleanupCalls += 1;
      },
    );
    if (i % 2 === 0) {
      editor.triggerDispose();
      binding.dispose();
    } else {
      binding.dispose();
      editor.triggerDispose();
    }
  }

  assert.equal(cleanupCalls, 20);
  assert.equal(registry.commands.size, 0);
  assert.equal(registry.bindings.length, 0);
});

test('every TextEditorPane Monaco shortcut uses disposable bindTextEditorActions without addCommand or contextMenuGroupId', () => {
  const source = readFileSync(new URL('./TextEditorPane.tsx', import.meta.url), 'utf8');
  const mount = source.slice(source.indexOf('const handleEditorMount:'), source.indexOf('// Capture-phase close-tab'));
  assert.match(mount, /actionBindingRef\.current\?\.dispose\(\);/);
  assert.match(mount, /bindTextEditorActions\(/);
  assert.equal(mount.match(/id:\s*'netcatty\.textEditor\.(?:save|closeTab|find|paste)'/g)?.length, 4);
  assert.doesNotMatch(source, /\.addCommand\(/);
  assert.doesNotMatch(source, /contextMenuGroupId\s*:/);
});
