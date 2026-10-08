import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ContextKeyExpr } = require('monaco-editor/esm/vs/platform/contextkey/common/contextkey.js');
const { KeybindingResolver } = require('monaco-editor/esm/vs/platform/keybinding/common/keybindingResolver.js');
import { registerTextEditorCommand } from './TextEditorPane.tsx';

test('save, close, find and paste resolve to the focused editor when two editors share a window', () => {
  const commands = new Map<string, Parameters<typeof registerTextEditorCommand>[2]>();
  const bindings: Array<{ command: string; commandArgs: undefined; chords: string[]; when: ReturnType<typeof ContextKeyExpr.deserialize>; isDefault: boolean; bubble: boolean }> = [];
  const calls: string[] = [];
  const actions = ['save', 'close', 'find', 'paste'];
  // Match the native regression: beta was created first, alpha last, then
  // beta was clicked. Unscoped Monaco commands incorrectly chose alpha.
  for (const editorId of ['vs.editor.ICodeEditor:beta', 'vs.editor.ICodeEditor:alpha']) {
    const editor = {
      getId: () => editorId,
      addCommand(keybinding: number, handler: Parameters<typeof registerTextEditorCommand>[2], context?: string) {
        const command = `${editorId}:${keybinding}`;
        commands.set(command, handler);
        bindings.push({ command, commandArgs: undefined, chords: [String(keybinding)], when: ContextKeyExpr.deserialize(context), isDefault: false, bubble: false });
        return command;
      },
    };
    actions.forEach((action, keybinding) => registerTextEditorCommand(editor, keybinding, () => { calls.push(`${editorId}:${action}`); }));
  }
  const resolver = new KeybindingResolver([], bindings, () => {});
  function press(editorId: string | undefined, keybinding: number) {
    const result = resolver.resolve({ getValue: (key: string) => key === 'editorId' ? editorId : undefined }, [], String(keybinding)) as { kind: number; commandId?: string };
    if (result.kind === 2) commands.get(result.commandId!)!(null as never);
    return result.kind;
  }
  for (const editorId of ['vs.editor.ICodeEditor:beta', 'vs.editor.ICodeEditor:alpha', 'vs.editor.ICodeEditor:beta']) {
    actions.forEach((action, keybinding) => {
      const before = calls.length;
      assert.equal(press(editorId, keybinding), 2);
      assert.deepEqual(calls.slice(before), [`${editorId}:${action}`]);
    });
  }
  const before = calls.length;
  actions.forEach((_, keybinding) => assert.equal(press(undefined, keybinding), 0));
  assert.equal(calls.length, before, 'no hidden editor handles keys outside editor context');
});

test('every TextEditorPane Monaco shortcut uses the scoped registration', () => {
  const source = readFileSync(new URL('./TextEditorPane.tsx', import.meta.url), 'utf8');
  const mount = source.slice(source.indexOf('const handleEditorMount:'), source.indexOf('// Capture-phase close-tab'));
  assert.equal(mount.match(/registerTextEditorCommand\(editor,/g)?.length, 4);
  assert.doesNotMatch(mount, /editor\.addCommand\(/);
});
