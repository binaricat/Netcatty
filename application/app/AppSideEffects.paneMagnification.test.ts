import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./AppSideEffects.tsx', import.meta.url), 'utf8');

test('terminal Escape restoration runs before xterm can stop propagation', () => {
  const effectStart = source.indexOf("const onCaptureKeyDown = (e: KeyboardEvent) => {");
  const effectSource = source.slice(effectStart, effectStart + 900);

  assert.notEqual(effectStart, -1);
  assert.match(effectSource, /target\.closest\('\.xterm'\)/);
  assert.match(effectSource, /window\.addEventListener\('keydown', onCaptureKeyDown, true\)/);
  assert.match(effectSource, /window\.removeEventListener\('keydown', onCaptureKeyDown, true\)/);
});
