import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  AI_COMPOSER_IDLE_MS,
  AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
  AI_MARKDOWN_WARMUP_RESUME_DELAY_MS,
  isAiComposerBusy,
  isAiComposerTarget,
  markAiComposerActivity,
  resolveAiMarkdownWarmupDelay,
  shouldDeferAiMarkdownWarmup,
} from './aiMarkdownWarmup';

test('defers markdown warmup while the composer is focused, composing, or recently active', () => {
  assert.equal(shouldDeferAiMarkdownWarmup({}), false);
  assert.equal(shouldDeferAiMarkdownWarmup({ composerFocused: true }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ isComposing: true }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ recentlyActive: true }), true);
});

test('recent composer activity counts as busy', () => {
  markAiComposerActivity();
  assert.equal(isAiComposerBusy(), true);
  assert.ok(AI_COMPOSER_IDLE_MS >= 2000);
});

test('recognizes the chat composer as a busy warmup target', () => {
  const body = { closest: (sel: string) => (sel.includes('ai-chat-input-body') ? {} : null) };
  assert.equal(isAiComposerTarget(body as unknown as EventTarget), true);
  assert.equal(isAiComposerTarget(null), false);
});

test('composer-idle IPC waits the same expand grace as history markdown', () => {
  const warmup = readFileSync(new URL('./aiMarkdownWarmup.ts', import.meta.url), 'utf8');
  assert.match(warmup, /initialDelayMs:\s*options\?\.initialDelayMs \?\? AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS/);
  assert.match(warmup, /isBusy: isAiComposerBusy/);
  assert.match(warmup, /markAiComposerActivity\(\);\n\s*arm\(\);/);
  assert.match(warmup, /if \(isAiComposerTyping\(\)\) \{\s*hydrateScheduled = true;/s);
});

test('history markdown waits after expand, then resumes quickly after blur', () => {
  assert.equal(AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS, 4000);
  assert.equal(AI_MARKDOWN_WARMUP_RESUME_DELAY_MS, 600);
  assert.equal(resolveAiMarkdownWarmupDelay({
    hasArmed: false,
    initialDelayMs: AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
    resumeDelayMs: AI_MARKDOWN_WARMUP_RESUME_DELAY_MS,
  }), 4000);
  assert.equal(resolveAiMarkdownWarmupDelay({
    hasArmed: true,
    initialDelayMs: AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
    resumeDelayMs: AI_MARKDOWN_WARMUP_RESUME_DELAY_MS,
  }), 600);
});

test('AI panel no longer starts Streamdown just because it became visible', () => {
  const panel = readFileSync(new URL('../AIChatSidePanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /scheduleAiMarkdownWarmup/);
  assert.match(panel, /warmAiMarkdownRenderer/);
  assert.doesNotMatch(panel, /timeout:\s*2500/);
  assert.doesNotMatch(panel, /import\('\.\/ai-elements\/messageResponse'\)/);
  assert.doesNotMatch(panel, /@streamdown\/code/);
});

test('chat history defers Streamdown until warmup is already done', () => {
  const list = readFileSync(new URL('./ChatMessageList.tsx', import.meta.url), 'utf8');
  assert.match(list, /deferUntilWarm/);
  assert.match(list, /scheduleAiMarkdownWarmup/);
  assert.match(list, /isAiComposerTyping/);
  assert.match(list, /AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS/);
  assert.match(list, /AI_MARKDOWN_WARMUP_RESUME_DELAY_MS/);
});

test('composer focus alone does not count as typing', () => {
  assert.equal(shouldDeferAiMarkdownWarmup({ composerFocused: true }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ composerFocused: true, isComposing: false, recentlyActive: false }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ isComposing: false, recentlyActive: false }), false);
});

test('LazyMessageResponse keeps plaintext while chat asks to defer', () => {
  const source = readFileSync(new URL('../ai-elements/LazyMessageResponse.tsx', import.meta.url), 'utf8');
  assert.match(source, /deferUntilWarm/);
  assert.match(source, /enqueueChatMarkdownHydrate/);
  assert.match(source, /isAiMarkdownRendererReady/);
});
