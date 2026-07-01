import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalOutputTriggerFilter } from './terminalOutputTriggerFilter.ts';

test('processServerChunk strips echoed user input before scanning', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('hello');
  const result = filter.processServerChunk('hello world');
  assert.equal(result.scannableText, '');
  assert.equal(result.meta.dropReason, 'editing-input-line');
});

test('processServerChunk strips echoed input across chunks after submit', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('abc');
  filter.noteUserInput('\r');
  filter.processServerChunk('abc\r\n');
  const result = filter.processServerChunk(' done');
  assert.equal(result.scannableText, ' done');
});

test('processServerChunk clears stale echo when server output diverges after submit', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('secret');
  filter.noteUserInput('\r');
  const result = filter.processServerChunk('Password:');
  assert.equal(result.scannableText, 'Password:');
});

test('processServerChunk suppresses text while alternate screen is active', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.processServerChunk('\x1b[?1049h');
  assert.equal(filter.processServerChunk('vim buffer').scannableText, '');
  assert.equal(filter.processServerChunk('vim buffer').alternateScreenActive, true);

  filter.processServerChunk('\x1b[?1049l');
  assert.equal(filter.processServerChunk('back to shell').scannableText, 'back to shell');
  assert.equal(filter.processServerChunk('back to shell').alternateScreenActive, false);
});

test('processServerChunk reports split alternate-screen leave with parameter lists', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.processServerChunk('\x1b[?1049h');

  const first = filter.processServerChunk('\x1b[?1;10');
  assert.equal(first.meta.alternateScreenAction, undefined);
  assert.equal(first.alternateScreenActive, true);

  const second = filter.processServerChunk('49lback');
  assert.equal(second.meta.alternateScreenAction, 'leave');
  assert.equal(second.alternateScreenActive, false);
  assert.equal(second.scannableText, 'back');
});

test('resetPendingEscape clears an incomplete non-alternate control sequence', () => {
  const filter = createTerminalOutputTriggerFilter();
  assert.equal(filter.processServerChunk('\x1b[31').meta.dropReason, 'pending-escape');

  filter.resetPendingEscape();
  const result = filter.processServerChunk('READY');

  assert.equal(result.scannableText, 'READY');
});

test('processServerChunk keeps command stdout after enter clears pending echo', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('echo NETCATTY_TRIGGER_PROBE');
  filter.noteUserInput('\r');
  const result = filter.processServerChunk('NETCATTY_TRIGGER_PROBE\r\n');
  assert.equal(result.scannableText, 'NETCATTY_TRIGGER_PROBE\r\n');
});

test('processServerChunk strips delayed submitted command echo but keeps stdout', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('echo NETCATTY_TRIGGER_PROBE');
  filter.noteUserInput('\r');
  const result = filter.processServerChunk('echo NETCATTY_TRIGGER_PROBE\r\nNETCATTY_TRIGGER_PROBE\r\n');
  assert.equal(result.scannableText, 'NETCATTY_TRIGGER_PROBE\r\n');
});

test('processServerChunk strips delayed bare submitted command echo', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('NETCATTY_TRIGGER_PROBE');
  filter.noteUserInput('\r');
  const result = filter.processServerChunk('NETCATTY_TRIGGER_PROBE\r\n');
  assert.equal(result.scannableText, '');
});

test('processServerChunk keeps command-not-found stderr after enter', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('netcatty-trigger-probe');
  filter.noteUserInput('\r');
  const result = filter.processServerChunk('netcatty-trigger-probe: command not found\r\n');
  assert.equal(result.scannableText, 'netcatty-trigger-probe: command not found\r\n');
});

test('noteUserInput tracks remapped backspace bytes sent to the session', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('\x08');
  const result = filter.processServerChunk('\x08 \x08');
  assert.equal(result.scannableText, ' \x08');
});

test('noteUserInput keeps large editable input state bounded', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('x'.repeat(10000));
  const result = filter.processServerChunk('READY');
  assert.equal(result.scannableText, '');
  assert.equal(result.meta.dropReason, 'editing-input-line');
  assert.equal(result.meta.afterSubmittedLen, 5);
});

test('processServerChunk suppresses uncertain long submitted input echo until the next line', () => {
  const filter = createTerminalOutputTriggerFilter();
  const longInput = `READY${'x'.repeat(5000)}`;
  filter.noteUserInput(longInput);
  filter.noteUserInput('\r');

  const result = filter.processServerChunk(`${longInput}\r\nserver READY\r\n`);

  assert.equal(result.scannableText, 'server READY\r\n');
});

test('markInputEchoUncertain suppresses one echoed input line before scanning again', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.markInputEchoUncertain();

  const first = filter.processServerChunk('READY');
  assert.equal(first.scannableText, '');

  const second = filter.processServerChunk('\r\nserver READY\r\n');
  assert.equal(second.scannableText, 'server READY\r\n');
});

test('markInputEchoUncertain suppresses multiple echoed input lines across chunks', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.markInputEchoUncertain(2);

  const first = filter.processServerChunk('READY1');
  assert.equal(first.scannableText, '');

  const second = filter.processServerChunk('\r\nREADY2\r\nserver READY\r\n');
  assert.equal(second.scannableText, 'server READY\r\n');
});

test('markInputEchoUncertain treats split CRLF as one echoed input line', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.markInputEchoUncertain(2);

  const first = filter.processServerChunk('READY1\r');
  assert.equal(first.scannableText, '');

  const second = filter.processServerChunk('\nREADY2\r\nserver READY\r\n');
  assert.equal(second.scannableText, 'server READY\r\n');
});

test('markInputEchoUncertain suppresses more than 1024 echoed input lines', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.markInputEchoUncertain(1100);

  const result = filter.processServerChunk(`${'x\n'.repeat(1100)}server READY\r\n`);
  assert.equal(result.scannableText, 'server READY\r\n');
});

test('markInputEchoUncertain still tracks alternate-screen controls in suppressed echo', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.markInputEchoUncertain();

  const suppressed = filter.processServerChunk('\x1b[?1049hecho READY\r\nREADY\r\n');
  assert.equal(suppressed.scannableText, '');
  assert.equal(suppressed.alternateScreenActive, true);

  const restored = filter.processServerChunk('\x1b[?1049lREADY\r\n');
  assert.equal(restored.scannableText, 'READY\r\n');
  assert.equal(restored.alternateScreenActive, false);
});

test('markInputEchoUncertain tracks split alternate-screen controls in suppressed echo', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.markInputEchoUncertain();

  const partial = filter.processServerChunk('\x1b[?104');
  assert.equal(partial.scannableText, '');

  const suppressed = filter.processServerChunk('9hecho READY\r\nREADY\r\n');
  assert.equal(suppressed.scannableText, '');
  assert.equal(suppressed.alternateScreenActive, true);

  const restored = filter.processServerChunk('\x1b[?1049lREADY\r\n');
  assert.equal(restored.scannableText, 'READY\r\n');
  assert.equal(restored.alternateScreenActive, false);
});

test('processServerChunk strips OSC cwd sequences without blocking later stdout', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('echo NETCATTY_TRIGGER_PROBE');
  filter.noteUserInput('\r');

  filter.processServerChunk('\x1b]7;file://VM-4-16-ubuntu/root\x07\x1b[?2004h');
  const result = filter.processServerChunk('\r\n\x1b[?2004l\rNETCATTY_TRIGGER_PROBE\r\n');
  assert.match(result.scannableText, /NETCATTY_TRIGGER_PROBE/);
  assert.notEqual(result.meta.dropReason, 'pending-escape');
});

test('processServerChunk strips split OSC sequences across chunks', () => {
  const filter = createTerminalOutputTriggerFilter();
  assert.equal(filter.processServerChunk('\x1b]7;file://host/root').scannableText, '');
  const result = filter.processServerChunk('/root\x07prompt# ');
  assert.equal(result.scannableText, 'prompt# ');
});

test('processServerChunk suppresses scan while command line is being edited', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('echo NETCATTY_TRIGGER_PROBE');
  const result = filter.processServerChunk('\x1b[7mNETCATTY_TRIGGER_PROBE\x1b[27m');
  assert.equal(result.scannableText, '');
  assert.equal(result.meta.dropReason, 'editing-input-line');
});

test('processServerChunk strips reverse-video echo without leaking SGR params', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('NETCATTY_TRIGGER_PROBE');
  const result = filter.processServerChunk('\x1b[7mNETCATTY_TRIGGER_PROBE\x1b[27m');
  assert.equal(result.scannableText, '');
  assert.equal(result.meta.dropReason, 'editing-input-line');
});

test('processServerChunk ignores bracketed paste wrappers when matching echo', () => {
  const filter = createTerminalOutputTriggerFilter();
  filter.noteUserInput('\x1b[200~echo NETCATTY_TRIGGER_PROBE\x1b[201~');
  filter.noteUserInput('\r');
  filter.processServerChunk('echo NETCATTY_TRIGGER_PROBE\r\n');
  const result = filter.processServerChunk('NETCATTY_TRIGGER_PROBE\r\n');
  assert.equal(result.scannableText, 'NETCATTY_TRIGGER_PROBE\r\n');
});
