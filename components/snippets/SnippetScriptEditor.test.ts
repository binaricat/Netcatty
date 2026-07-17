import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editorSource = readFileSync(new URL('./SnippetScriptEditor.tsx', import.meta.url), 'utf8');

test('snippet editing uses the Monaco editor with find and replace in both layouts', () => {
  assert.doesNotMatch(editorSource, /CodeTextarea/);
  assert.equal(editorSource.match(/<ScriptCodeEditor/g)?.length, 2);
  assert.equal(editorSource.match(/language="shell"/g)?.length, 2);
  assert.equal(editorSource.match(/\sfill(?:\s|\n)/g)?.length, 2);
  assert.equal(editorSource.match(/placeholder=\{placeholder\}/g)?.length, 2);
});
