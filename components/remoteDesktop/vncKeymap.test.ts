import assert from 'node:assert/strict';
import test from 'node:test';
import {
  domCodeToQemuKeycode,
  domEventToVncKeysym,
  textToVncKeysymSequence,
  unicodeCharToVncKeysym,
  VNC_SPECIAL_CHORDS,
  X11_KEYSYM,
} from './vncKeymap';

test('vncKeymap maps modifiers, navigation, function keys, and numpad keys', () => {
  assert.equal(domEventToVncKeysym({ key: 'Control', code: 'ControlLeft' }), X11_KEYSYM.Control_L);
  assert.equal(domEventToVncKeysym({ key: 'Control', code: 'ControlRight' }), X11_KEYSYM.Control_R);
  assert.equal(domEventToVncKeysym({ key: 'Alt', code: 'AltRight' }), X11_KEYSYM.Alt_R);
  assert.equal(domEventToVncKeysym({ key: 'Meta', code: 'MetaLeft' }), X11_KEYSYM.Super_L);
  assert.equal(domEventToVncKeysym({ key: 'ArrowUp', code: 'ArrowUp' }), X11_KEYSYM.Up);
  assert.equal(domEventToVncKeysym({ key: 'Delete', code: 'Delete' }), X11_KEYSYM.Delete);
  assert.equal(domEventToVncKeysym({ key: 'F12', code: 'F12' }), X11_KEYSYM.F12);
  assert.equal(domEventToVncKeysym({ key: 'Enter', code: 'NumpadEnter' }), X11_KEYSYM.KP_Enter);
});

test('vncKeymap maps printable ASCII, Latin-1, and Unicode characters with 0x01000000 bit', () => {
  assert.equal(domEventToVncKeysym({ key: 'a', code: 'KeyA' }), 0x61);
  assert.equal(domEventToVncKeysym({ key: 'A', code: 'KeyA' }), 0x41);
  assert.equal(domEventToVncKeysym({ key: 'é' }), 0xe9);
  assert.equal(unicodeCharToVncKeysym('中'), 0x01000000 | 0x4e2d);
  assert.equal(domEventToVncKeysym({ key: 'Process' }), null);
  assert.equal(domEventToVncKeysym({ key: 'Dead' }), null);
});

test('vncKeymap maps DOM codes to QEMU extended XT scancodes', () => {
  assert.equal(domCodeToQemuKeycode('KeyA'), 0x1e);
  assert.equal(domCodeToQemuKeycode('ControlLeft'), 0x1d);
  assert.equal(domCodeToQemuKeycode('ControlRight'), 0x80 | 0x1d);
  assert.equal(domCodeToQemuKeycode('ArrowUp'), 0x80 | 0x48);
  assert.equal(domCodeToQemuKeycode('Delete'), 0x80 | 0x53);
  assert.equal(domCodeToQemuKeycode('MetaLeft'), 0x80 | 0x5b);
  assert.equal(domCodeToQemuKeycode('UnknownKey'), null);
});

test('vncKeymap converts clipboard strings into X11 keysym sequences', () => {
  assert.deepEqual(textToVncKeysymSequence('Hi!\r\n\t中'), [
    0x48,
    0x69,
    0x21,
    X11_KEYSYM.Return,
    X11_KEYSYM.Tab,
    0x01000000 | 0x4e2d,
  ]);
  assert.deepEqual(VNC_SPECIAL_CHORDS['ctrl-alt-del'], [
    X11_KEYSYM.Control_L,
    X11_KEYSYM.Alt_L,
    X11_KEYSYM.Delete,
  ]);
});
