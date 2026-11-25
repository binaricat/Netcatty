import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as Monaco from 'monaco-editor';
const require = createRequire(import.meta.url);
const { ContextKeyExpr } = require('monaco-editor/esm/vs/platform/contextkey/common/contextkey.js');
const { KeybindingResolver } = require('monaco-editor/esm/vs/platform/keybinding/common/keybindingResolver.js');
import { bindScriptEditorActions } from './ScriptCodeEditor.tsx';

type RegisteredBinding = {
  command: string;
  commandArgs: undefined;
  chords: string[];
  when: ReturnType<typeof ContextKeyExpr.deserialize>;
  isDefault: boolean;
  bubble: boolean;
};

test('bindScriptEditorActions scopes actions per editor and disposes all handles on onDidDispose and unmount', () => {
  const commands = new Map<string, () => void>();
  const bindings: RegisteredBinding[] = [];

  function createEditor(editorId: string) {
    const disposeListeners = new Set<() => void>();
    let actionDisposals = 0;
    let onDidDisposeDisposals = 0;

    return {
      addAction(descriptor: Monaco.editor.IActionDescriptor) {
        assert.equal(descriptor.contextMenuGroupId, undefined, 'contextMenuGroupId must be omitted');
        assert.ok(descriptor.label.trim().length > 0, 'action must provide a non-empty label');
        const uniqueId = `${editorId}:${descriptor.id}`;
        const when = ContextKeyExpr.equals('editorId', editorId);
        commands.set(uniqueId, () => {
          void descriptor.run({} as Monaco.editor.ICodeEditor);
        });
        const added: RegisteredBinding[] = [];
        for (const kb of descriptor.keybindings ?? []) {
          const entry: RegisteredBinding = {
            command: uniqueId,
            commandArgs: undefined,
            chords: [String(kb)],
            when,
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
            actionDisposals += 1;
            commands.delete(uniqueId);
            for (const entry of added) {
              const idx = bindings.indexOf(entry);
              if (idx >= 0) bindings.splice(idx, 1);
            }
          },
        };
      },
      onDidDispose(listener: () => void) {
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
        for (const listener of [...disposeListeners]) listener();
      },
      get stats() {
        return { actionDisposals, onDidDisposeDisposals, activeListeners: disposeListeners.size };
      },
    };
  }

  const calls: string[] = [];
  const editorA = createEditor('script:a');
  const editorB = createEditor('script:b');
  let cleanupsA = 0;
  let cleanupsB = 0;

  const bindingA = bindScriptEditorActions(
    editorA,
    [
      { id: 'netcatty.scriptEditor.submit', label: 'Submit Script', keybinding: 10, run: () => calls.push('a:submit') },
      { id: 'netcatty.scriptEditor.paste', label: 'Paste', keybinding: 20, run: () => calls.push('a:paste') },
    ],
    () => { cleanupsA += 1; },
  );
  const bindingB = bindScriptEditorActions(
    editorB,
    [
      { id: 'netcatty.scriptEditor.paste', label: 'Paste', keybinding: 20, run: () => calls.push('b:paste') },
    ],
    () => { cleanupsB += 1; },
  );

  const press = (editorId: string, kb: number) => {
    const resolver = new KeybindingResolver([], bindings, () => {});
    const res = resolver.resolve(
      { getValue: (key: string) => (key === 'editorId' ? editorId : undefined) },
      [],
      String(kb),
    ) as { kind: number; commandId?: string };
    if (res.kind === 2) commands.get(res.commandId!)!();
    return res.kind;
  };

  assert.equal(press('script:a', 10), 2);
  assert.equal(press('script:a', 20), 2);
  assert.equal(press('script:b', 20), 2);
  assert.deepEqual(calls, ['a:submit', 'a:paste', 'b:paste']);

  // Dispose A via editor.onDidDispose
  editorA.triggerDispose();
  bindingA.dispose();
  assert.equal(cleanupsA, 1);
  assert.equal(editorA.stats.actionDisposals, 2);
  assert.equal(editorA.stats.onDidDisposeDisposals, 1);
  assert.equal(editorA.stats.activeListeners, 0);
  assert.equal(commands.size, 1);
  assert.equal(bindings.length, 1);

  // Dispose B via React unmount before onDidDispose
  bindingB.dispose();
  editorB.triggerDispose();
  assert.equal(cleanupsB, 1);
  assert.equal(editorB.stats.actionDisposals, 1);
  assert.equal(editorB.stats.onDidDisposeDisposals, 1);
  assert.equal(editorB.stats.activeListeners, 0);
  assert.equal(commands.size, 0);
  assert.equal(bindings.length, 0);
});

test('ScriptCodeEditor uses disposable bindScriptEditorActions without addCommand or contextMenuGroupId', () => {
  const source = readFileSync(new URL('./ScriptCodeEditor.tsx', import.meta.url), 'utf8');
  assert.match(source, /actionBindingRef\.current\?\.dispose\(\);/);
  assert.match(source, /bindScriptEditorActions\(/);
  assert.match(source, /id:\s*'netcatty\.scriptEditor\.submit'/);
  assert.match(source, /id:\s*'netcatty\.scriptEditor\.paste'/);
  assert.doesNotMatch(source, /\.addCommand\(/);
  assert.doesNotMatch(source, /contextMenuGroupId\s*:/);
});
