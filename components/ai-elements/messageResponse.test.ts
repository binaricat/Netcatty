import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('messageResponse does not statically import Shiki', () => {
  const source = readFileSync(new URL('./messageResponse.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]@streamdown\/code['"]/);
  assert.doesNotMatch(source, /from ['"]shiki(?:\/|['"])/);
  assert.match(source, /from ['"]@streamdown\/cjk['"]/);
  assert.match(source, /hasMarkdownCodeFence/);
  assert.match(source, /warmAiCodeHighlighter/);
  assert.match(source, /scheduleWhenAiComposerIdle/);
});

test('Shiki lives in an isolated fine-grained plugin module', () => {
  const plugin = readFileSync(new URL('./streamdownCodePlugin.ts', import.meta.url), 'utf8');
  const warmup = readFileSync(new URL('./streamdownCodeWarmup.ts', import.meta.url), 'utf8');
  assert.match(plugin, /from ['"]shiki\/core['"]/);
  assert.match(plugin, /from ['"]shiki\/engine\/javascript['"]/);
  assert.doesNotMatch(plugin, /from ['"]@streamdown\/code['"]/);
  assert.doesNotMatch(plugin, /from ['"]shiki['"]/);
  assert.match(warmup, /import\('\.\/streamdownCodePlugin'\)/);
  assert.doesNotMatch(warmup, /from ['"]@streamdown\/code['"]/);
  assert.doesNotMatch(warmup, /from ['"]shiki(?:\/|['"])/);
});
