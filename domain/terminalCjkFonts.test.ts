import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTerminalCjkFontOptions,
  getTerminalCjkFontSelectionStatus,
} from './terminalCjkFonts';

test('builds recommended choices first and includes every installed family once', () => {
  const options = buildTerminalCjkFontOptions({
    installedFamilies: [
      'PingFang SC',
      'sarasa mono sc',
      'Custom CJK Mono',
      'PINGFANG SC',
    ],
    selectedValue: '',
  });

  assert.deepEqual(
    options.map(({ value, kind }) => ({ value, kind })),
    [
      { value: '', kind: 'auto' },
      { value: 'Sarasa Mono SC', kind: 'recommended' },
      { value: 'Custom CJK Mono', kind: 'installed' },
      { value: 'PingFang SC', kind: 'installed' },
    ],
  );
});

test('keeps a synced or manually entered font visible when it is not installed', () => {
  const options = buildTerminalCjkFontOptions({
    installedFamilies: ['Sarasa Mono SC'],
    selectedValue: 'Missing Family',
  });

  assert.deepEqual(options.at(-1), {
    value: 'Missing Family',
    kind: 'unavailable',
  });
});

test('preserves the selected value when it matches an installed family after normalization', () => {
  const options = buildTerminalCjkFontOptions({
    installedFamilies: ['PingFang SC', 'Sarasa Mono SC'],
    selectedValue: '  pingfang sc  ',
  });

  assert.deepEqual(options.find((option) => option.kind === 'installed'), {
    value: '  pingfang sc  ',
    kind: 'installed',
  });
});

test('preserves an unavailable selected value exactly', () => {
  const options = buildTerminalCjkFontOptions({
    installedFamilies: [],
    selectedValue: '  Missing Family  ',
  });

  assert.deepEqual(options.at(-1), {
    value: '  Missing Family  ',
    kind: 'unavailable',
  });
});

test('does not claim a selected font is unavailable when detection did not run', () => {
  const options = buildTerminalCjkFontOptions({
    installedFamilies: null,
    selectedValue: 'Unverified Local Font',
  });

  assert.deepEqual(options.at(-1), {
    value: 'Unverified Local Font',
    kind: 'unverified',
  });
});

test('reports safe, risky, and unavailable selections for user guidance', () => {
  assert.equal(
    getTerminalCjkFontSelectionStatus('', ['PingFang SC']),
    'auto',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('Sarasa Mono SC', ['Sarasa Mono SC']),
    'recommended',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('Sarasa Mono SC', [], ['Sarasa Mono SC']),
    'recommended',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('Maple Mono CN', ['PingFang SC']),
    'unavailable',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('PingFang SC', ['PingFang SC']),
    'alignment-risk',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('Missing Family', ['PingFang SC']),
    'unavailable',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('PingFang SC', null, [], true),
    'alignment-risk',
  );
  assert.equal(
    getTerminalCjkFontSelectionStatus('Unverified Local Font', null),
    'alignment-risk',
  );
});
