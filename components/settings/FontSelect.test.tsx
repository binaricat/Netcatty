import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('font picker uses the searchable combobox and preserves font previews', () => {
  const source = readFileSync(new URL('./FontSelect.tsx', import.meta.url), 'utf8');

  assert.match(source, /<Combobox/);
  assert.match(source, /placeholder=\{t\('common\.searchPlaceholder'\)\}/);
  assert.match(source, /emptyText=\{t\('common\.noResultsFound'\)\}/);
  assert.match(source, /labelStyle: \{ fontFamily: font\.family \}/);
  assert.match(source, /inputStyle=\{\{ fontFamily: selectedFont\?\.family \}\}/);
  assert.match(source, /clearable=\{false\}/);
  assert.match(source, /selectValueOnFocus/);
  assert.match(source, /ariaLabel=\{ariaLabel\}/);
});

test('terminal font picker reuses the shared searchable font picker', () => {
  const source = readFileSync(new URL('./TerminalFontSelect.tsx', import.meta.url), 'utf8');

  assert.match(source, /<FontSelect/);
  assert.match(source, /fonts=\{visibleFonts\}/);
  assert.doesNotMatch(source, /<Combobox/);
});
