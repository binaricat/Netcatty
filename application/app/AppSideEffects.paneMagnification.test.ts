import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./AppSideEffects.tsx', import.meta.url), 'utf8');

test('quick-switcher Escape handling stays in the bubble phase', () => {
  const effectStart = source.indexOf('const onKeyDown = (e: KeyboardEvent) => {\n      _handleEscapeKeyDown(e);');
  const effectEnd = source.indexOf('}, [appLockLocked]);', effectStart);
  const effectSource = source.slice(effectStart, effectEnd);

  assert.notEqual(effectStart, -1);
  assert.match(effectSource, /window\.addEventListener\('keydown', onKeyDown\)/);
  assert.match(effectSource, /window\.removeEventListener\('keydown', onKeyDown\)/);
  assert.doesNotMatch(source, /onCaptureKeyDown/);
});
