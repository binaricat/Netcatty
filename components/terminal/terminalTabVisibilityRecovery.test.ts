import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./useTerminalEffects.ts', import.meta.url), 'utf8');

test('continuous rendering mode creates renderers for inactive panes immediately', () => {
  assert.match(source, /initiallyVisible: isRendererActive/);
});

test('tab-return recovery is restricted to hibernate mode', () => {
  assert.match(source, /const becameVisible = isVisible && !wasVisibleRef\.current/);
  assert.match(
    source,
    /if \(becameVisible\) \{\s*if \(hibernateHiddenTabs\) \{\s*recoverTerminalAfterBecomeVisible\(\);\s*\}\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(isVisible \|\| !hibernateHiddenTabs\) return;\s*lastCommittedVisibleLayoutKeyRef\.current = null/,
  );
});

test('app visibility and focus do not trigger terminal recovery', () => {
  assert.doesNotMatch(source, /document\.addEventListener\('visibilitychange'/);
  assert.doesNotMatch(source, /window\.addEventListener\('focus'/);
  assert.doesNotMatch(source, /terminalBackend\.onWindowShown/);
});
