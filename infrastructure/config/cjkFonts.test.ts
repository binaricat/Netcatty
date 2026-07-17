import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeFontFamilyStack,
  getDefaultCjkFallback,
  getRecommendedCjkFor,
  splitFontFamilyList,
  CJK_SYSTEM_FALLBACK_STACK,
} from './cjkFonts';

describe('composeFontFamilyStack', () => {
  it('puts the primary font first', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: '',
      latinFontId: 'menlo',
      platform: 'darwin',
    });
    assert.match(stack, /^Menlo,\s*/);
  });

  it('inserts user fallback right after primary when provided', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: '"Fira Code", monospace',
      userFallback: 'Sarasa Mono SC',
      latinFontId: 'fira-code',
      platform: 'darwin',
    });
    const firaIdx = stack.indexOf('Fira Code');
    const userIdx = stack.indexOf('Sarasa Mono SC');
    assert.ok(firaIdx >= 0 && userIdx > firaIdx, 'user fallback after primary');
  });

  it('uses per-Latin-font recommended CJK when user fallback is empty', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: '"Cascadia Code", monospace',
      userFallback: '',
      latinFontId: 'cascadia-code',
      platform: 'win32',
    });
    // Cascadia Code now recommends Sarasa Mono SC (true monospace).
    assert.match(stack, /Sarasa Mono SC/);
  });

  it('falls back to OS default when Latin font has no recommendation', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: '"Unknown Font", monospace',
      userFallback: '',
      latinFontId: 'unknown',
      platform: 'darwin',
    });
    // macOS no-recommendation default is now Sarasa Mono SC (bundled).
    assert.match(stack, /Sarasa Mono SC/);
  });

  it('quotes multi-word user fallback names', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: 'Source Han Mono SC',
      latinFontId: 'menlo',
      platform: 'linux',
    });
    assert.match(stack, /"Source Han Mono SC"/);
  });

  it('keeps an unquoted user fallback containing a comma as one font family', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: 'Foo, Inc. Mono',
      latinFontId: 'menlo',
      platform: 'darwin',
    });

    assert.ok(stack.includes('"Foo, Inc. Mono"'));
    assert.ok(splitFontFamilyList(stack).includes('"Foo, Inc. Mono"'));
  });

  it('escapes quotes inside a manually entered font family', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: 'Foo"Bar',
      latinFontId: 'menlo',
      platform: 'darwin',
    });

    assert.ok(stack.includes('"Foo\\"Bar"'));
    assert.ok(splitFontFamilyList(stack).includes('"Foo\\"Bar"'));
  });

  it('quotes a manually entered font family containing an apostrophe', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: "Rock'nRoll",
      latinFontId: 'menlo',
      platform: 'darwin',
    });

    assert.ok(stack.includes('"Rock\'nRoll"'));
    assert.ok(splitFontFamilyList(stack).includes('"Rock\'nRoll"'));
  });

  it('quotes a manually entered font family that starts with a digit', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: '3270font',
      latinFontId: 'menlo',
      platform: 'darwin',
    });

    assert.ok(stack.includes('"3270font"'));
    assert.ok(splitFontFamilyList(stack).includes('"3270font"'));
  });

  it('keeps CSS generic font families unquoted', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo, monospace',
      userFallback: 'ui-monospace',
      latinFontId: 'menlo',
      platform: 'darwin',
    });

    assert.ok(splitFontFamilyList(stack).includes('ui-monospace'));
  });

  it('does not duplicate identical fallback entries', () => {
    // User explicitly picks the same font the per-font pairing would,
    // and that font also lives in the system stack — should appear once.
    const stack = composeFontFamilyStack({
      primaryFamily: '"Cascadia Code", monospace',
      userFallback: 'Sarasa Mono SC',
      latinFontId: 'cascadia-code',
      platform: 'win32',
    });
    const matches = stack.match(/Sarasa Mono SC/g) || [];
    assert.equal(matches.length, 1);
  });

  it('inserts JetBrains Mono as Latin-only fallback right after the primary family', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: 'Menlo',
      userFallback: '',
      latinFontId: 'menlo',
      platform: 'darwin',
    });
    const families = stack.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    assert.equal(families[0], 'Menlo');
    assert.equal(families[1], 'JetBrains Mono');
  });

  it('Latin fallback (JetBrains Mono) precedes every CJK family', () => {
    // Regression guard for codex P1 review on PR #940 (first round):
    // when the primary font isn't installed, Latin glyphs must fall to
    // a Latin-only monospace face — NOT a CJK font's full-width Latin
    // variant — to keep xterm's fixed cell grid aligned. JetBrains Mono
    // is bundled via @fontsource and contains no CJK glyphs, so it
    // catches Latin while letting CJK glyphs flow past.
    const stack = composeFontFamilyStack({
      primaryFamily: '"Fira Code", monospace',
      userFallback: 'LXGW WenKai Mono',
      latinFontId: 'fira-code',
      platform: 'darwin',
    });
    const jbIdx = stack.indexOf('JetBrains Mono');
    const sarasaIdx = stack.indexOf('Sarasa Mono SC');
    const userFallbackIdx = stack.indexOf('LXGW WenKai Mono');
    const simSunIdx = stack.indexOf('SimSun');
    assert.ok(jbIdx > 0, 'JetBrains Mono must appear in the stack');
    assert.ok(jbIdx < userFallbackIdx, 'JetBrains Mono before user CJK');
    assert.ok(jbIdx < sarasaIdx, 'JetBrains Mono before Sarasa system fallback');
    assert.ok(jbIdx < simSunIdx, 'JetBrains Mono before SimSun system fallback');
  });

  it('preserves a quoted primary family name that contains a comma', () => {
    // Regression guard for codex P2 review on PR #940: when the primary
    // family is something like `"Foo, Inc. Mono"`, the composed stack
    // must keep that token intact rather than splitting on the internal
    // comma and emitting fragmented pieces.
    const stack = composeFontFamilyStack({
      primaryFamily: '"Foo, Inc. Mono", monospace',
      userFallback: '',
      latinFontId: 'foo-inc-mono',
      platform: 'darwin',
    });
    assert.ok(
      stack.includes('"Foo, Inc. Mono"'),
      'quoted family with comma stays a single token',
    );
    assert.ok(
      !stack.includes('"Foo,') || stack.includes('"Foo, Inc. Mono"'),
      'must not produce a dangling `"Foo,` fragment',
    );
  });

  it('user-chosen CJK fallback precedes generic monospace', () => {
    // Regression guard for codex P1 review on PR #940 (second round):
    // generic `monospace` on macOS Chrome resolves Chinese glyphs to
    // PingFang via Chromium's CJK system fallback. If `monospace`
    // appeared in the chain BEFORE the user's CJK pick, CSS per-glyph
    // fallback would stop at monospace for CJK characters and never
    // consult the user's choice, silently nullifying the CJK picker.
    const stack = composeFontFamilyStack({
      primaryFamily: '"Fira Code", monospace',
      userFallback: 'LXGW WenKai Mono',
      latinFontId: 'fira-code',
      platform: 'darwin',
    });
    const userFallbackIdx = stack.indexOf('LXGW WenKai Mono');
    // Match `monospace` as a standalone token (after the comma+space).
    const monospaceIdx = stack.lastIndexOf(', monospace');
    assert.ok(userFallbackIdx > 0, 'user CJK must appear');
    assert.ok(monospaceIdx > userFallbackIdx, 'user CJK must come before generic monospace');
  });

  it('explicit user fallback overrides the per-font recommendation', () => {
    const stack = composeFontFamilyStack({
      primaryFamily: '"JetBrains Mono", monospace',
      userFallback: 'LXGW WenKai Mono',
      latinFontId: 'jetbrains-mono',
      platform: 'darwin',
    });
    // User chose LXGW WenKai Mono; the JetBrains Mono recommendation
    // (Sarasa Mono SC) should be suppressed, so Sarasa only shows up
    // later in the system fallback stack, AFTER the user choice.
    const userIdx = stack.indexOf('LXGW WenKai Mono');
    const sarasaIdx = stack.indexOf('Sarasa Mono SC');
    assert.ok(userIdx >= 0);
    assert.ok(sarasaIdx > userIdx, 'system Sarasa appears after explicit user choice');
  });
});

describe('getDefaultCjkFallback', () => {
  it('returns SimSun on Windows (always installed, monospace)', () => {
    assert.equal(getDefaultCjkFallback('win32'), 'SimSun');
  });
  it('returns Sarasa Mono SC on macOS (bundled by app)', () => {
    assert.equal(getDefaultCjkFallback('darwin'), 'Sarasa Mono SC');
  });
  it('returns Noto Sans Mono CJK SC on Linux', () => {
    assert.equal(getDefaultCjkFallback('linux'), 'Noto Sans Mono CJK SC');
  });
  it('never returns a known proportional font', () => {
    const proportional = ['PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Hiragino Sans GB'];
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const v = getDefaultCjkFallback(platform);
      assert.ok(!proportional.includes(v), `${platform} default ${v} must not be proportional`);
    }
  });
});

describe('getRecommendedCjkFor', () => {
  it('returns null for unknown fonts', () => {
    assert.equal(getRecommendedCjkFor('unknown-font-id', 'darwin'), null);
  });
  it('returns a non-empty string for known fonts', () => {
    const v = getRecommendedCjkFor('jetbrains-mono', 'darwin');
    assert.ok(v && v.length > 0);
  });
});

describe('splitFontFamilyList', () => {
  it('splits a simple comma-separated list', () => {
    assert.deepEqual(
      splitFontFamilyList('Menlo, monospace'),
      ['Menlo', 'monospace'],
    );
  });

  it('keeps quoted family names with commas intact', () => {
    // Regression guard for codex P2 review on PR #940: a font family
    // name like `"Foo, Inc. Mono"` is a single token in CSS, not two.
    assert.deepEqual(
      splitFontFamilyList('"Foo, Inc. Mono", monospace'),
      ['"Foo, Inc. Mono"', 'monospace'],
    );
  });

  it('handles a single unquoted name', () => {
    assert.deepEqual(splitFontFamilyList('Iosevka'), ['Iosevka']);
  });

  it('handles single quotes too', () => {
    assert.deepEqual(
      splitFontFamilyList("'Foo, Inc.', serif"),
      ["'Foo, Inc.'", 'serif'],
    );
  });

  it('keeps escaped quotes inside a quoted family name', () => {
    assert.deepEqual(
      splitFontFamilyList('"Foo\\"Bar", monospace'),
      ['"Foo\\"Bar"', 'monospace'],
    );
  });

  it('drops empty segments produced by double commas', () => {
    assert.deepEqual(
      splitFontFamilyList('Menlo,, monospace'),
      ['Menlo', 'monospace'],
    );
  });
});

describe('CJK_SYSTEM_FALLBACK_STACK', () => {
  it('contains true-monospace CJK fonts only', () => {
    assert.match(CJK_SYSTEM_FALLBACK_STACK, /Sarasa Mono SC/);
    assert.match(CJK_SYSTEM_FALLBACK_STACK, /Noto Sans Mono CJK SC/);
    assert.match(CJK_SYSTEM_FALLBACK_STACK, /SimSun/);
  });

  it('does not include known proportional CJK fonts', () => {
    assert.doesNotMatch(CJK_SYSTEM_FALLBACK_STACK, /PingFang SC/);
    assert.doesNotMatch(CJK_SYSTEM_FALLBACK_STACK, /Microsoft YaHei UI/);
    assert.doesNotMatch(CJK_SYSTEM_FALLBACK_STACK, /Hiragino Sans GB/);
  });
});
