import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { isTerminalReportSequence } from './terminalReportSequence';
const require = createRequire(import.meta.url);
const backend = require('../electron/bridges/terminalReportSequence.cjs');

test('renderer and backend agree on protocol replies and distinguish keyboard escape sequences', () => {
  const replies = ['\x1b[I', '\x1b[O', '\x1b[1;2R', '\x1b[?1;2c', '\x1b[>1;2c', '\x1b[?997;1n',
    '\x1b[?3u', '\x1b[?2004;1$y', '\x1b[8;24;80t', '\x1b[6;12;8t', '\x1b[4;1080;1920t',
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b]4;255;rgb:ffff/0000/ffff\x1b\\',
    '\x1b]11;rgb:0000/0000/0000\x07', '\x1bP1$r0m\x1b\\'];
  const keys = ['hello', '\r', '\x7f', '\x15', '\x1b[A', '\x1b[D', '\x1b[3~', '\x1bOD', '\x1bx', '\x1b[200~paste\x1b[201~'];
  for (const [values, expected] of [[replies, true], [keys, false]] as const) {
    for (const value of values) {
      assert.equal(isTerminalReportSequence(value), expected, JSON.stringify(value));
      assert.equal(isTerminalReportSequence(value), backend.isTerminalReportSequence(value), JSON.stringify(value));
    }
  }
});
