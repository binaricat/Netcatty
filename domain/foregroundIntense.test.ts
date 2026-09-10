import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createForegroundIntenseTransformer,
  parseHexColor,
  resolveForegroundIntenseRgb,
} from './foregroundIntense.ts';

const INTENSE = [255, 96, 0] as const;
const ESC = '\x1b';

test('parseHexColor handles #rgb, #rrggbb and rejects junk', () => {
  assert.deepEqual(parseHexColor('#ff9900'), [255, 153, 0]);
  assert.deepEqual(parseHexColor('#f90'), [255, 153, 0]);
  assert.deepEqual(parseHexColor(' #12ABcd '), [0x12, 0xab, 0xcd]);
  assert.equal(parseHexColor('nope'), null);
  assert.equal(parseHexColor(undefined), null);
});

test('resolveForegroundIntenseRgb is off when intense is missing, invalid or equal to foreground', () => {
  assert.equal(resolveForegroundIntenseRgb({ foreground: '#c9d1d9' }), null);
  assert.equal(
    resolveForegroundIntenseRgb({ foreground: '#c9d1d9', foregroundIntense: 'zzz' }),
    null,
  );
  assert.equal(
    resolveForegroundIntenseRgb({ foreground: '#c9d1d9', foregroundIntense: '#C9D1D9' }),
    null,
  );
  assert.deepEqual(
    resolveForegroundIntenseRgb({ foreground: '#c9d1d9', foregroundIntense: '#ff6000' }),
    [255, 96, 0],
  );
});

test('SGR 1 with default foreground injects the intense truecolor', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  assert.equal(t.transform(`${ESC}[1m`), `${ESC}[1;38;2;255;96;0m`);
  assert.equal(t.transform(`${ESC}[39m`), `${ESC}[39;38;2;255;96;0m`);
});

test('SGR 39;1 (default foreground + bold) injects the intense truecolor', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  assert.equal(t.transform(`${ESC}[39;1m`), `${ESC}[39;1;38;2;255;96;0m`);
});

test('SGR 22 / 0 clear the injected color back to the default foreground', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  t.transform(`${ESC}[1m`);
  assert.equal(t.transform(`${ESC}[22m`), `${ESC}[22;39m`);
  t.transform(`${ESC}[1m`);
  assert.equal(t.transform(`${ESC}[0m`), `${ESC}[0m`);
  // No spurious revert after a full reset.
  assert.equal(t.transform(`${ESC}[1m`), `${ESC}[1;38;2;255;96;0m`);
});

test('explicit ANSI colors are untouched and use the existing bright logic', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  assert.equal(t.transform(`${ESC}[1;36m`), `${ESC}[1;36m`);
  assert.equal(t.transform(`${ESC}[36;1m`), `${ESC}[36;1m`);
  // Bold + cyan then reset to default foreground: bold + default is intense.
  assert.equal(t.transform(`${ESC}[39m`), `${ESC}[39;38;2;255;96;0m`);
});

test('truecolor and 256-color foregrounds suppress injection until reset', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  assert.equal(t.transform(`${ESC}[38;2;1;2;3m`), `${ESC}[38;2;1;2;3m`);
  assert.equal(t.transform(`${ESC}[1m`), `${ESC}[1m`);
  assert.equal(t.transform(`${ESC}[38;5;196;1m`), `${ESC}[38;5;196;1m`);
  assert.equal(t.transform(`${ESC}[39m`), `${ESC}[39;38;2;255;96;0m`);
});

test('background extended colors are skipped and not read as foreground', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  assert.equal(t.transform(`${ESC}[48;5;196m`), `${ESC}[48;5;196m`);
  assert.equal(t.transform(`${ESC}[1m`), `${ESC}[1;38;2;255;96;0m`);
  t.reset();
  assert.equal(t.transform(`${ESC}[48;2;9;9;9;1m`), `${ESC}[48;2;9;9;9;1;38;2;255;96;0m`);
  t.reset();
  assert.equal(t.transform(`${ESC}[38:2:1:2:3;1m`), `${ESC}[38:2:1:2:3;1m`);
});

test('sequences split across chunks are transformed correctly', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  const seq = `${ESC}[1m`;
  assert.equal(t.transform(seq.slice(0, 3)), '');
  assert.equal(t.transform(seq.slice(3)), `${ESC}[1;38;2;255;96;0m`);
  // OSC titles pass through unharmed.
  assert.equal(t.transform(`${ESC}]0;title\x07`), `${ESC}]0;title\x07`);
  assert.equal(t.transform(`${ESC}]2;ti`), '');
  assert.equal(t.transform('tle' + ESC + '\\'), `${ESC}]2;title` + ESC + '\\');
  // Incomplete trailing sequence is buffered, not lost.
  assert.equal(t.transform('hello' + ESC), 'hello');
  assert.equal(t.transform('[22'), '');
  assert.equal(t.transform('m'), `${ESC}[22;39m`);
  assert.equal(t.flush(), '');
});

test('flush returns a held partial sequence', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  t.transform('text' + ESC);
  assert.equal(t.flush(), ESC);
  assert.equal(t.transform('after'), 'after');
});

test('transformer with null rgb is a pass-through', () => {
  const t = createForegroundIntenseTransformer(null);
  assert.equal(t.transform(`${ESC}[1m${ESC}[39;1mplain`), `${ESC}[1m${ESC}[39;1mplain`);
});

test('theme switch from intense back to null reverts outstanding injection', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  assert.equal(t.transform(`${ESC}[1m`), `${ESC}[1;38;2;255;96;0m`);
  // Color removed (theme change): bold stays but injection is turned off and
  // the outstanding injected color is cleared on the next SGR boundary.
  t.setColor(null);
  assert.equal(t.transform(`${ESC}[22m`), `${ESC}[22;39m`);
  // Re-enabling keeps working.
  t.setColor([...INTENSE]);
  assert.equal(t.transform(`${ESC}[1m`), `${ESC}[1;38;2;255;96;0m`);
});

test('RIS full reset clears tracked bold state', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  t.transform(`${ESC}[1m`);
  assert.equal(t.transform(`${ESC}c`), `${ESC}c`);
  assert.equal(t.transform(`${ESC}[0Jtext`), `${ESC}[0Jtext`);
});

test('plain text chunks are returned unchanged (fast path)', () => {
  const t = createForegroundIntenseTransformer([...INTENSE]);
  t.transform(`${ESC}[1m`);
  const plain = 'lorem ipsum '.repeat(50);
  assert.equal(t.transform(plain), plain);
});
