import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalReflowReadingPosition } from './terminalReflowReadingPosition';
import { resolveTerminalReflowScrollAnchor } from './terminalHelpers';

function fixture() {
  let cols = 80;
  let text = Array.from({ length: 1000 }, (_, i) => String(i).padStart(4, '0') + ' ').join('');
  const buffer = {
    viewportY: 30,
    get length() { return Math.ceil(text.length / cols) + 30; },
    get baseY() { return this.length - 25; },
    getLine(row: number) {
      const count = Math.ceil(text.length / cols);
      if (row >= this.length) return undefined;
      return {
        isWrapped: row > 0 && row < count,
        translateToString: () => row < count ? text.slice(row * cols, (row + 1) * cols) : `follower ${row - count}`,
      };
    },
  };
  const tracker = createTerminalReflowReadingPosition();
  return {
    buffer,
    changeText() { text = text.replace('0480', 'EDIT'); },
    fit(nextCols: number) {
      const anchor = tracker.capture(buffer, { oldCols: cols, newCols: nextCols, maxRows: 1030 });
      cols = nextCols;
      const row = anchor ? resolveTerminalReflowScrollAnchor(buffer, anchor, 0) : null;
      if (row !== null) buffer.viewportY = row;
      tracker.remember(buffer, anchor);
    },
  };
}

test('continuous shrink and grow retain the original character within the top row', () => {
  const f = fixture();
  for (const cols of [...Array.from({ length: 40 }, (_, i) => 79 - i), ...Array.from({ length: 40 }, (_, i) => 41 + i)]) {
    f.fit(cols);
    assert.equal(f.buffer.viewportY, Math.floor(2400 / cols));
  }
});

test('user scroll and changed visible output establish a new reading position', () => {
  const f = fixture();
  f.fit(79);
  f.buffer.viewportY = 20;
  f.fit(78);
  assert.equal(f.buffer.viewportY, Math.floor(20 * 79 / 78));
  const g = fixture();
  g.fit(79);
  g.changeText();
  g.fit(78);
  assert.equal(g.buffer.viewportY, Math.floor(30 * 79 / 78));
});
