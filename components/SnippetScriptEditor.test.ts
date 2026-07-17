import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const snippetEditorSource = readFileSync(
  new URL('./snippets/SnippetScriptEditor.tsx', import.meta.url),
  'utf8',
);
const codeEditorSource = readFileSync(
  new URL('./scripts/ScriptCodeEditor.tsx', import.meta.url),
  'utf8',
);

test('snippet editing uses the Monaco editor in both inline and expanded layouts', () => {
  assert.doesNotMatch(snippetEditorSource, /CodeTextarea/);
  assert.equal(snippetEditorSource.match(/<ScriptCodeEditor\s/g)?.length, 2);
  assert.equal(snippetEditorSource.match(/language="shell"/g)?.length, 2);
  assert.equal(snippetEditorSource.match(/placeholder=\{placeholder\}/g)?.length, 2);
});

test('inline snippet editing preserves form focus behavior', () => {
  assert.match(snippetEditorSource, /inlineEditorRef\.current\?\.focus\(\)/);
  assert.match(snippetEditorSource, /\sref=\{inlineEditorRef\}/);
  assert.match(snippetEditorSource, /\stabFocusMode(?:\s|\n)/);
  assert.match(codeEditorSource, /tabFocusMode,/);
});

test('snippet editor forwards the surrounding form submit shortcut', () => {
  assert.equal(snippetEditorSource.match(/onSubmitShortcut=\{onSubmitShortcut\}/g)?.length, 2);
  assert.match(codeEditorSource, /if \(onSubmitShortcut\)/);
  assert.match(codeEditorSource, /KeyMod\.CtrlCmd \| monacoInstance\.KeyCode\.Enter/);
  assert.match(codeEditorSource, /onSubmitShortcutRef\.current\?\.\(\)/);
});

test('dialog submit handlers ignore shortcuts already handled by Monaco', () => {
  const quickAddSource = readFileSync(new URL('./QuickAddSnippetDialog.tsx', import.meta.url), 'utf8');
  const tmuxSource = readFileSync(
    new URL('./systemManager/TmuxNewSessionModal.tsx', import.meta.url),
    'utf8',
  );
  assert.match(quickAddSource, /if \(e\.defaultPrevented\) return/);
  assert.match(tmuxSource, /if \(e\.defaultPrevented\) return/);
});

test('visual placeholder is hidden from assistive technology', () => {
  assert.match(codeEditorSource, /<span\s+aria-hidden/);
});
