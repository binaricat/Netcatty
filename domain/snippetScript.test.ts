import assert from 'node:assert/strict';
import test from 'node:test';
import { getSnippetKind, isScriptSnippet, scriptContainsWriteOperations } from './snippetScript.ts';

test('getSnippetKind defaults to snippet', () => {
  assert.equal(getSnippetKind({}), 'snippet');
  assert.equal(getSnippetKind({ kind: undefined }), 'snippet');
});

test('isScriptSnippet detects script kind', () => {
  assert.equal(isScriptSnippet({ kind: 'script' }), true);
  assert.equal(isScriptSnippet({ kind: 'snippet' }), false);
});

test('scriptContainsWriteOperations detects terminal writes', () => {
  assert.equal(scriptContainsWriteOperations("await nct.screen.sendLine('ls');"), true);
  assert.equal(scriptContainsWriteOperations("await nct.screen.waitFor('$ ');"), false);
});
