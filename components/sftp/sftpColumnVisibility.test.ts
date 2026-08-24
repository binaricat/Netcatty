import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSftpColumnTemplate,
  DEFAULT_SFTP_COLUMN_VISIBILITY,
  isSftpColumnMenuKey,
  normalizeSftpColumnVisibility,
  type ColumnWidths,
} from './utils.ts';

const widths: ColumnWidths = {
  name: 56,
  modified: 28,
  size: 7,
  type: 9,
  owner: 10,
};

test('normalizes missing and invalid SFTP column preferences to all columns', () => {
  assert.deepEqual(normalizeSftpColumnVisibility(null), DEFAULT_SFTP_COLUMN_VISIBILITY);
  assert.deepEqual(normalizeSftpColumnVisibility('invalid'), DEFAULT_SFTP_COLUMN_VISIBILITY);
});

test('keeps the name column visible while restoring optional column preferences', () => {
  assert.deepEqual(
    normalizeSftpColumnVisibility({ name: false, modified: false, size: true, type: false, owner: false }),
    { name: true, modified: false, size: true, type: false, owner: false },
  );
});

test('treats a missing owner preference as visible', () => {
  assert.equal(
    normalizeSftpColumnVisibility({ name: true, modified: true, size: true, type: true }).owner,
    true,
  );
});

test('builds a grid containing only visible SFTP columns', () => {
  const template = buildSftpColumnTemplate(widths, {
    name: true,
    modified: false,
    size: true,
    type: false,
    owner: false,
  });

  assert.equal(template, 'minmax(140px, 56fr) minmax(52px, 7fr)');
});

test('includes the owner column when it is visible', () => {
  const template = buildSftpColumnTemplate(widths, {
    name: true,
    modified: false,
    size: false,
    type: false,
    owner: true,
  });

  assert.equal(template, 'minmax(140px, 56fr) minmax(56px, 10fr)');
});

test('can reduce the SFTP file list to only the name column', () => {
  assert.equal(
    buildSftpColumnTemplate(widths, {
      name: true,
      modified: false,
      size: false,
      type: false,
      owner: false,
    }),
    'minmax(140px, 56fr)',
  );
});

test('recognizes standard keyboard shortcuts for opening the column menu', () => {
  assert.equal(isSftpColumnMenuKey('ContextMenu', false), true);
  assert.equal(isSftpColumnMenuKey('F10', true), true);
  assert.equal(isSftpColumnMenuKey('F10', false), false);
  assert.equal(isSftpColumnMenuKey('Enter', false), false);
});
