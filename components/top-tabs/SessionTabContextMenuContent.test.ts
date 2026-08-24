import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isSessionReconnectDisabled } from './SessionTabContextMenuContent';

const source = readFileSync(fileURLToPath(new URL('./SessionTabContextMenuContent.tsx', import.meta.url)), 'utf8');

test('reconnect is disabled while a session is still connecting', () => {
  assert.equal(isSessionReconnectDisabled('connecting'), true);
  assert.equal(isSessionReconnectDisabled('connected'), false);
  assert.equal(isSessionReconnectDisabled('disconnected'), false);
  assert.equal(isSessionReconnectDisabled('disconnected', true), true);
});

test('session tab menu exposes optional edit-host when a vault host is present', () => {
  assert.match(source, /editHost\?: Host/);
  assert.match(source, /onEditHost\?: \(host: Host\) => void/);
  assert.match(source, /editHost && onEditHost/);
  assert.match(source, /terminal\.layer\.hostTree\.editHost/);
});
