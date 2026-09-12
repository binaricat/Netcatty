const test = require('node:test');
const assert = require('node:assert/strict');
const terminalBridge = require('./terminalBridge.cjs');
const { encodeTerminalInput, normalizeTerminalEncoding } = require('./terminalEncoding.cjs');

for (const charset of ['utf-8', 'GBK', 'Shift_JIS', 'Big5', 'EUC-JP', 'latin1', 'utf-16', 'unknown']) {
  test(`serial byte deletion matches actual ${charset} input and preserves preceding text`, () => {
    const encoding = normalizeTerminalEncoding(charset);
    let wire = Buffer.alloc(0);
    const serialPort = { write(data) {
      for (const byte of Buffer.from(data)) {
        wire = byte === 127 || byte === 8 ? wire.subarray(0, Math.max(0, wire.length - 1)) : Buffer.concat([wire, Buffer.from([byte])]);
      }
    } };
    terminalBridge.init({ sessions: new Map([['serial', {type: 'serial', protocol: 'serial', encoding, serialPort}]]), electronModule: {} });
    for (const char of ['你', 'é', 'ü', 'α', '〿', 'ｱ', '龘', '❤️', '𠀀']) {
      wire = Buffer.alloc(0);
      terminalBridge.writeToSession({}, {sessionId: 'serial', data: 'abc' + char});
      assert.equal(wire.length, 3 + Buffer.byteLength(encodeTerminalInput(char, encoding)));
      terminalBridge.writeToSession({}, {sessionId: 'serial', data: '\x7f', serialEraseChar: char});
      assert.equal(wire.toString(), 'abc', char);
    }
  });
}

test('ordinary serial and non-serial input retain one Backspace', () => {
  for (const serial of [true, false]) {
    const writes = [];
    const session = serial ? {serialPort: {write: data => writes.push(data)}} : {stream: {write: data => writes.push(data)}};
    terminalBridge.init({sessions: new Map([['s', session]]), electronModule: {}});
    terminalBridge.writeToSession({}, {sessionId: 's', data: '\x7f', ...(!serial ? {serialEraseChar: '你'} : {})});
    assert.deepEqual(writes, ['\x7f']);
  }
});

test('serial byte deletion uses the current backend encoding and preserves other keys', () => {
  const writes = [];
  const session = {serialPort: {write: data => writes.push(Buffer.from(data))}, encoding: 'gb18030'};
  terminalBridge.init({sessions: new Map([['s', session]]), electronModule: {}});
  terminalBridge.writeToSession({}, {sessionId: 's', data: '\b', serialEraseChar: '你'});
  session.encoding = 'utf-8';
  terminalBridge.writeToSession({}, {sessionId: 's', data: '\b', serialEraseChar: '你'});
  terminalBridge.writeToSession({}, {sessionId: 's', data: '\x03', serialEraseChar: '你'});
  assert.deepEqual(writes.map(b => [...b]), [[8, 8], [8, 8, 8], [3]]);
});
