import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('messageResponse does not statically import Shiki', () => {
  const source = readFileSync(new URL('./messageResponse.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]@streamdown\/code['"]/);
  assert.match(source, /from ['"]@streamdown\/cjk['"]/);
  assert.match(source, /hasMarkdownCodeFence/);
  assert.match(source, /warmAiCodeHighlighter/);
  assert.match(source, /scheduleWhenAiComposerIdle/);
});

test('Shiki lives in an isolated plugin module', () => {
  const plugin = readFileSync(new URL('./streamdownCodePlugin.ts', import.meta.url), 'utf8');
  const warmup = readFileSync(new URL('./streamdownCodeWarmup.ts', import.meta.url), 'utf8');
  assert.match(plugin, /from ['"]@streamdown\/code['"]/);
  assert.match(warmup, /import\('\.\/streamdownCodePlugin'\)/);
  assert.doesNotMatch(warmup, /from ['"]@streamdown\/code['"]/);
});
