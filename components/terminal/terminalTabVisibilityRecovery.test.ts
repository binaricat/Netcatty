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
    /if \(!isVisible\) \{\s*wasVisibleRef\.current = false;\s*syncOutputPressureVisibility\(\);\s*return;\s*\}[\s\S]*if \(splitResizeActive\) return;[\s\S]*wasVisibleRef\.current = true;[\s\S]*recoverTerminalAfterBecomeVisible\(\)/,
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
  const fullRecoveryIndex = source.indexOf('xtermRuntimeRef.current?.clearTextureAtlas();', recoverIndex);
  const fastPath = source.slice(fastPathIndex, fullRecoveryIndex);

  assert.ok(recoverIndex >= 0);
  assert.ok(fastPathIndex > recoverIndex);
  assert.ok(fullRecoveryIndex > fastPathIndex);
  assert.match(
    fastPath,
    /currentContainerSizeAlreadyFit\(\)[\s\S]*lastWebglRecoveryLayoutKeyRef\.current = paneLayoutKey;[\s\S]*commitVisibleLayout\(\);[\s\S]*return;/,
  );
  assert.doesNotMatch(fastPath, /runImmediateRefit|scheduleLayoutRecoveryRefit/);
});

// Chromium can reclaim a hidden pane's WebGL context at any time, and the
// context budget releases renderers of panes hidden for a while. The fast
// path must still bring a missing renderer back (a no-op when it is live).
test('short unchanged tab reveals still restore a lost WebGL renderer', () => {
  const recoverIndex = source.indexOf('const recoverTerminalAfterBecomeVisible = () => {');
  const fastPathIndex = source.indexOf('getHiddenDurationMs() < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS', recoverIndex);
  const fullRecoveryIndex = source.indexOf('xtermRuntimeRef.current?.clearTextureAtlas();', recoverIndex);

  assert.match(
    source.slice(fastPathIndex, fullRecoveryIndex),
    /xtermRuntimeRef\.current\?\.ensureWebglRenderer\(\);[\s\S]*commitVisibleLayout\(\);\s*return;/,
  );
});

test('pane visibility reaches the WebGL context budget before reveal recovery runs', () => {
  const syncIndex = source.indexOf('xtermRuntimeRef.current?.syncPaneVisibility();');
  const revealEffectIndex = source.indexOf('const becameVisible = isVisible && !wasVisibleRef.current');
  assert.ok(syncIndex >= 0);
  assert.ok(syncIndex < revealEffectIndex);
  assert.match(source, /isPaneVisibleRef: isVisibleRef,/);
});

test('short unchanged tab reveals still flush pending hidden-output scroll', () => {
  const recoverIndex = source.indexOf('const recoverTerminalAfterBecomeVisible = () => {');
  const fastPathIndex = source.indexOf('getHiddenDurationMs() < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS', recoverIndex);
  const webglRecoveryIndex = source.indexOf('xtermRuntimeRef.current?.clearTextureAtlas();', recoverIndex);
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
    /if \(lastWebglRecoveryLayoutKeyRef\.current === paneLayoutKey\) \{/,
  );
});

test('reveal does not claim recovery before the terminal runtime exists', () => {
  const start = source.indexOf('const recoverTerminalAfterBecomeVisible = () => {');
  const end = source.indexOf('// Refit synchronously', start);
  const recovery = source.slice(start, end);
  const runtimeGuard = recovery.indexOf('if (!termRef.current || !xtermRuntimeRef.current) return;');
  const commit = recovery.indexOf('lastWebglRecoveryLayoutKeyRef.current = paneLayoutKey');
  assert.ok(runtimeGuard >= 0 && runtimeGuard < commit);
});

test('settling tab-layout probes do not force a fit when bounds are unchanged', () => {
  const start = source.indexOf('const refitSettledLayout = () => {');
  const end = source.indexOf('}, [inWorkspace, isVisible]);', start);
  const settling = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(settling, /if \(!isVisibleRef\.current \|\| currentContainerSizeAlreadyFit\(\)\) return;/);
  assert.match(settling, /safeFit\(\{ requireVisible: true \}\);/);
  assert.doesNotMatch(settling, /force: true/);
  assert.match(settling, /setTimeout\(refitSettledLayout, 100\)/);
  assert.match(settling, /setTimeout\(refitSettledLayout, 350\)/);
});
