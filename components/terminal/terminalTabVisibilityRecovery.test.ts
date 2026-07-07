import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./useTerminalEffects.ts', import.meta.url), 'utf8');

test('clears committed layout state when a terminal pane hides', () => {
  assert.match(source, /if \(isVisible\) return;[\s\S]*lastCommittedVisibleLayoutKeyRef\.current = null/);
  assert.match(source, /lastWebglRecoveryLayoutKeyRef\.current = null/);
});

test('forces full recovery when a terminal pane becomes visible again', () => {
  assert.match(source, /const becameVisible = isVisible && !wasVisibleRef\.current/);
  assert.match(source, /recoverTerminalAfterBecomeVisible\(\)/);
  assert.match(source, /nudgeAlternateScreenRedraw\(term\)/);
  assert.match(source, /syncPtySizeAfterLayout/);
});

test('layout recovery refit also syncs PTY size for full-screen TUIs', () => {
  assert.match(source, /runImmediateRefit\(\{ force: true, repeatOnNextFrame: false \}\);\s*finishLayoutRecoveryAfterFit\(\)/);
  assert.match(source, /finishLayoutRecoveryAfterFit/);
});

test('tab-switch suppression does not consume the visible recovery pass', () => {
  assert.match(source, /const becameVisible = isVisible && !wasVisibleRef\.current/);
  assert.match(
    source,
    /if \(!isVisible\) \{\s*wasVisibleRef\.current = false;\s*return;\s*\}[\s\S]*if \(splitResizeActive\) return;[\s\S]*wasVisibleRef\.current = true;[\s\S]*recoverTerminalAfterBecomeVisible\(\)/,
  );
  assert.doesNotMatch(source, /wasVisibleRef\.current = isVisible;\s*if \(!isVisible \|\| isResizing\) return/);
});

test('immediate visibility recovery does not wait for the next animation frame', () => {
  assert.match(source, /safeFit\(\{ force, requireVisible: true, immediate: true \}\)/);
  assert.match(source, /safeFit\(\{ force: true, requireVisible: true, immediate: true \}\)/);
});

test('visible tab recovery reuses a cached fit when the container size is unchanged', () => {
  assert.match(source, /const currentContainerSizeAlreadyFit = \(\) => \{/);
  assert.match(
    source,
    /if \(currentContainerSizeAlreadyFit\(\)\) \{\s*finishLayoutRecovery\(\);\s*flushPendingOutputScroll\(\);\s*commitVisibleLayout\(\);\s*return;\s*\}/,
  );
});

test('short unchanged tab reveals skip the recovery work entirely', () => {
  const recoverIndex = source.indexOf('const recoverTerminalAfterBecomeVisible = () => {');
  const fastPathIndex = source.indexOf('getHiddenDurationMs() < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS', recoverIndex);
  const webglRecoveryIndex = source.indexOf('xtermRuntimeRef.current?.ensureWebglRenderer();', recoverIndex);

  assert.ok(recoverIndex >= 0);
  assert.ok(fastPathIndex > recoverIndex);
  assert.ok(webglRecoveryIndex > fastPathIndex);
  assert.match(
    source.slice(fastPathIndex, webglRecoveryIndex),
    /currentContainerSizeAlreadyFit\(\)[\s\S]*lastWebglRecoveryLayoutKeyRef\.current = paneLayoutKey;[\s\S]*commitVisibleLayout\(\);[\s\S]*return;/,
  );
});

test('short unchanged tab reveals still flush pending hidden-output scroll', () => {
  const recoverIndex = source.indexOf('const recoverTerminalAfterBecomeVisible = () => {');
  const fastPathIndex = source.indexOf('getHiddenDurationMs() < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS', recoverIndex);
  const webglRecoveryIndex = source.indexOf('xtermRuntimeRef.current?.ensureWebglRenderer();', recoverIndex);
  const delayedSkipIndex = source.indexOf('lastWebglRecoveryLayoutKeyRef.current === paneLayoutKey', webglRecoveryIndex);
  const delayedTimerIndex = source.indexOf('const timer = setTimeout', delayedSkipIndex);

  assert.match(
    source,
    /const flushPendingOutputScroll = \(\) => \{[\s\S]*pendingOutputScrollRef\.current[\s\S]*scrollToBottom\(\)[\s\S]*pendingOutputScrollRef\.current = false;/,
  );
  assert.match(
    source.slice(fastPathIndex, webglRecoveryIndex),
    /flushPendingOutputScroll\(\);[\s\S]*commitVisibleLayout\(\);[\s\S]*return;/,
  );
  assert.match(
    source.slice(delayedSkipIndex, delayedTimerIndex),
    /flushPendingOutputScroll\(\);\s*return;/,
  );
});

test('visible tab recovery drains hidden terminal writes before any fast-path return', () => {
  const recoverIndex = source.indexOf('const recoverTerminalAfterBecomeVisible = () => {');
  const fastPathIndex = source.indexOf('getHiddenDurationMs() < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS', recoverIndex);
  const flushCallIndex = source.indexOf('flushTerminalWritesAfterBecomeVisible();', recoverIndex);

  assert.ok(recoverIndex >= 0);
  assert.ok(fastPathIndex > recoverIndex);
  assert.ok(flushCallIndex > recoverIndex && flushCallIndex < fastPathIndex);
});

test('visible split-pane recovery no longer defers background panes', () => {
  const effectIndex = source.indexOf('const becameVisible = isVisible && !wasVisibleRef.current');
  const effectEnd = source.indexOf('}, [isVisible, paneLayoutKey, splitResizeActive]);', effectIndex);
  const effectSource = source.slice(effectIndex, effectEnd);

  assert.ok(effectIndex >= 0);
  assert.ok(effectEnd > effectIndex);
  assert.match(
    source,
    /if \(becameVisible\) \{\s*recoverTerminalAfterBecomeVisible\(\);\s*return;\s*\}/,
  );
  assert.doesNotMatch(effectSource, /\binWorkspace\b/);
  assert.doesNotMatch(effectSource, /\bisFocusMode\b/);
  assert.doesNotMatch(effectSource, /\bisFocused\b/);
  assert.doesNotMatch(source, /shouldRefitImmediatelyOnShow/);
  assert.doesNotMatch(source, /shouldRecoverWebglOnShow/);
  assert.doesNotMatch(source, /const runDeferred = \(\) => \{/);
  assert.doesNotMatch(source, /scheduleLayoutRecoveryRefit\(\[120, 350\]\)/);
});

test('immediate tab recovery marks webgl recovery to skip the delayed duplicate pass', () => {
  assert.match(
    source,
    /const recoverTerminalAfterBecomeVisible = \(\) => \{[\s\S]*xtermRuntimeRef\.current\?\.clearTextureAtlas\(\);\s*lastWebglRecoveryLayoutKeyRef\.current = paneLayoutKey;/,
  );
  assert.match(
    source,
    /lastWebglRecoveryLayoutKeyRef\.current === paneLayoutKey\s*&& hiddenMs < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS/,
  );
});
