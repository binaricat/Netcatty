import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS,
  MAX_AI_TOOL_OUTPUT_MAX_CHARS,
  MIN_AI_TOOL_OUTPUT_MAX_CHARS,
  normalizeAiToolOutputMaxChars,
  resolveTerminalStderrMaxChars,
} from './aiToolOutputLimit';

test('normalizeAiToolOutputMaxChars falls back to default for missing or non-finite inputs', () => {
  assert.equal(normalizeAiToolOutputMaxChars(undefined), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(null), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(''), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(false), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(true), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(Number.NaN), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(Number.POSITIVE_INFINITY), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(Number.NEGATIVE_INFINITY), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars('not-a-number'), DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS);
});

test('normalizeAiToolOutputMaxChars clamps values to safe min/max bounds and rounds decimals', () => {
  assert.equal(normalizeAiToolOutputMaxChars(-500), MIN_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(0), MIN_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(MIN_AI_TOOL_OUTPUT_MAX_CHARS - 1), MIN_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(MIN_AI_TOOL_OUTPUT_MAX_CHARS), MIN_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(64_000), 64_000);
  assert.equal(normalizeAiToolOutputMaxChars('48000'), 48_000);
  assert.equal(normalizeAiToolOutputMaxChars(32_000.6), 32_001);
  assert.equal(normalizeAiToolOutputMaxChars(MAX_AI_TOOL_OUTPUT_MAX_CHARS), MAX_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(MAX_AI_TOOL_OUTPUT_MAX_CHARS + 1), MAX_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(normalizeAiToolOutputMaxChars(10_000_000), MAX_AI_TOOL_OUTPUT_MAX_CHARS);
});

test('resolveTerminalStderrMaxChars matches legacy 12,000 default and scales cleanly with custom limits', () => {
  assert.equal(resolveTerminalStderrMaxChars(DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS), 12_000);
  assert.equal(resolveTerminalStderrMaxChars(MIN_AI_TOOL_OUTPUT_MAX_CHARS), MIN_AI_TOOL_OUTPUT_MAX_CHARS);
  assert.equal(resolveTerminalStderrMaxChars(100_000), 50_000);
  assert.equal(resolveTerminalStderrMaxChars(MAX_AI_TOOL_OUTPUT_MAX_CHARS), 100_000);
  assert.equal(resolveTerminalStderrMaxChars(Number.NaN), 12_000);
});
