import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodingCliOutputScanner,
  inferCodingCliProviderFromOutput,
  stripTerminalControlSequences,
} from './codingCliOutputDetect';

test('inferCodingCliProviderFromOutput detects Codex startup banner', () => {
  assert.equal(
    inferCodingCliProviderFromOutput('>_ OpenAI Codex (v0.141.0)\r\nmodel: gpt-5.5'),
    'codex',
  );
  assert.equal(
    inferCodingCliProviderFromOutput('OpenAI Codex (v0.141.0)'),
    'codex',
  );
});

test('inferCodingCliProviderFromOutput detects other CLI banners', () => {
  assert.equal(inferCodingCliProviderFromOutput('Welcome to Claude Code'), 'claude');
  assert.equal(inferCodingCliProviderFromOutput('GitHub Copilot CLI'), 'copilot');
  assert.equal(inferCodingCliProviderFromOutput('Factory Droid ready'), 'droid');
});

test('createCodingCliOutputScanner finds providers across chunked output', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(scanner.feed('>_ Open'), undefined);
  assert.equal(scanner.feed('AI Codex (v0.141.0)'), 'codex');
  assert.equal(scanner.feed('more output'), 'codex');
});

test('stripTerminalControlSequences removes ANSI color codes', () => {
  const stripped = stripTerminalControlSequences('\x1b[1mOpenAI Codex\x1b[0m');
  assert.equal(stripped, 'OpenAI Codex');
});
