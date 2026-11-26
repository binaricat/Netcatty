import assert from 'node:assert/strict';
import test from 'node:test';
import {
  domCodeToRdpScancode,
  isExtendedRdpScancode,
  RDP_SCANCODE,
  RDP_SPECIAL_CHORDS,
} from './rdpScancodeMap';

test('rdpScancodeMap maps standard alphanumeric, modifier, and function keys', () => {
  assert.equal(domCodeToRdpScancode('Escape'), 0x0001);
  assert.equal(domCodeToRdpScancode('KeyA'), 0x001e);
  assert.equal(domCodeToRdpScancode('Enter'), 0x001c);
  assert.equal(domCodeToRdpScancode('ShiftLeft'), 0x002a);
  assert.equal(domCodeToRdpScancode('ControlLeft'), 0x001d);
  assert.equal(domCodeToRdpScancode('F1'), 0x003b);
  assert.equal(domCodeToRdpScancode('F12'), 0x0058);
  assert.equal(isExtendedRdpScancode(RDP_SCANCODE.KeyA), false);
});

test('rdpScancodeMap encodes extended keys with 0xE0 prefix', () => {
  assert.equal(domCodeToRdpScancode('ArrowUp'), 0xe048);
  assert.equal(domCodeToRdpScancode('ArrowDown'), 0xe050);
  assert.equal(domCodeToRdpScancode('ArrowLeft'), 0xe04b);
  assert.equal(domCodeToRdpScancode('ArrowRight'), 0xe04d);
  assert.equal(domCodeToRdpScancode('Delete'), 0xe053);
  assert.equal(domCodeToRdpScancode('ControlRight'), 0xe01d);
  assert.equal(domCodeToRdpScancode('AltRight'), 0xe038);
  assert.equal(domCodeToRdpScancode('MetaLeft'), 0xe05b);
  assert.equal(domCodeToRdpScancode('NumpadEnter'), 0xe01c);
  assert.equal(isExtendedRdpScancode(RDP_SCANCODE.Delete), true);
  assert.equal(domCodeToRdpScancode('NonExistentCode'), null);
});

test('rdpScancodeMap defines Ctrl+Alt+Del and other special chords', () => {
  assert.deepEqual(RDP_SPECIAL_CHORDS['ctrl-alt-del'], [
    RDP_SCANCODE.ControlLeft,
    RDP_SCANCODE.AltLeft,
    RDP_SCANCODE.Delete,
  ]);
  assert.deepEqual(RDP_SPECIAL_CHORDS['alt-f4'], [
    RDP_SCANCODE.AltLeft,
    RDP_SCANCODE.F4,
  ]);
});
