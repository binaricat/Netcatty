import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_FONTS,
  getDefaultTerminalFontIdForPlatform,
  detectFontPlatform,
  resolveTerminalFontFamilyId,
  isSameResolvedTerminalFont,
  TERMINAL_FONT_AUTO,
} from './fonts';

/**
 * Proportional (non-monospace) fonts must never appear in the terminal
 * primary font dropdown. They produce broken cell-grid alignment because
 * xterm.js samples cell width from a single probe glyph, and a font with
 * variable-width Latin glyphs renders other characters with inconsistent
 * widths around (or beyond) that cell.
 */
const KNOWN_PROPORTIONAL_FONTS = [
  // CJK system fonts — proportional sans-serif designed for body text.
  'PingFang SC',
  'PingFang TC',
  'PingFang HK',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'Hiragino Sans GB',
  'Hiragino Sans',
  'Heiti SC',
  'Heiti TC',
  // Latin proportional fonts that get mistakenly listed as "terminal
  // fonts". Comic Sans MS was historically in this dropdown labeled
  // "non-traditional terminal font" — picking it produced bloated cell
  // widths because Comic Sans is a handwriting-style proportional face.
  'Comic Sans MS',
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Times',
  'Georgia',
  'Verdana',
  'Trebuchet MS',
  'Tahoma',
];

describe('TERMINAL_FONTS dropdown contents', () => {
  it('does not list any known proportional font as a primary choice', () => {
    for (const banned of KNOWN_PROPORTIONAL_FONTS) {
      const matches = TERMINAL_FONTS.filter((f) =>
        f.name === banned ||
        f.family.includes(`"${banned}"`) ||
        f.family.split(',')[0].trim() === banned,
      );
      assert.deepEqual(
        matches,
        [],
        `${banned} must not appear in TERMINAL_FONTS — it is proportional and breaks terminal grid alignment`,
      );
    }
  });

  it('every entry has a non-empty id, name, and family', () => {
    for (const font of TERMINAL_FONTS) {
      assert.ok(font.id.length > 0, `${JSON.stringify(font)} missing id`);
      assert.ok(font.name.length > 0, `${font.id} missing name`);
      assert.ok(font.family.length > 0, `${font.id} missing family`);
    }
  });

  it('font ids are unique', () => {
    const seen = new Set<string>();
    for (const font of TERMINAL_FONTS) {
      assert.equal(seen.has(font.id), false, `duplicate id: ${font.id}`);
      seen.add(font.id);
    }
  });
});

describe('getDefaultTerminalFontIdForPlatform', () => {
  it('uses a locally-installed Windows font (no webfont swap on cold start)', () => {
    assert.equal(getDefaultTerminalFontIdForPlatform('win32'), 'consolas');
  });

  it('uses the most widely pre-installed Linux monospace font', () => {
    assert.equal(getDefaultTerminalFontIdForPlatform('linux'), 'dejavu-sans-mono');
  });

  it('keeps the macOS system font default', () => {
    assert.equal(getDefaultTerminalFontIdForPlatform('darwin'), 'menlo');
  });

  it('falls back to the macOS default for unknown platforms', () => {
    assert.equal(getDefaultTerminalFontIdForPlatform('freebsd'), 'menlo');
  });

  it('only ever returns ids that exist in TERMINAL_FONTS', () => {
    const ids = new Set(TERMINAL_FONTS.map((f) => f.id));
    for (const platform of ['darwin', 'win32', 'linux', 'unknown']) {
      assert.ok(
        ids.has(getDefaultTerminalFontIdForPlatform(platform)),
        `default for ${platform} not in TERMINAL_FONTS`,
      );
    }
  });
});

describe('resolveTerminalFontFamilyId', () => {
  it('resolves the auto sentinel to the per-platform default', () => {
    assert.equal(resolveTerminalFontFamilyId(TERMINAL_FONT_AUTO, 'Win32'), 'consolas');
    assert.equal(resolveTerminalFontFamilyId(TERMINAL_FONT_AUTO, 'MacIntel'), 'menlo');
    assert.equal(resolveTerminalFontFamilyId(TERMINAL_FONT_AUTO, 'Linux x86_64'), 'dejavu-sans-mono');
  });

  it('treats empty/nullish ids as auto (resolves per platform)', () => {
    assert.equal(resolveTerminalFontFamilyId('', 'Win32'), 'consolas');
    assert.equal(resolveTerminalFontFamilyId(null, 'MacIntel'), 'menlo');
    assert.equal(resolveTerminalFontFamilyId(undefined, 'Linux'), 'dejavu-sans-mono');
  });

  it('keeps an explicit font id regardless of platform', () => {
    assert.equal(resolveTerminalFontFamilyId('jetbrains-mono', 'Win32'), 'jetbrains-mono');
    assert.equal(resolveTerminalFontFamilyId('menlo', 'Win32'), 'menlo');
  });
});

describe('isSameResolvedTerminalFont', () => {
  it('treats clicking the displayed default while stored=auto as a no-op', () => {
    // Prevents the side panel from pinning a concrete per-OS font (which would
    // then sync across devices) on a no-op-looking click of the shown default.
    assert.equal(isSameResolvedTerminalFont('consolas', TERMINAL_FONT_AUTO, 'Win32'), true);
    assert.equal(isSameResolvedTerminalFont('menlo', TERMINAL_FONT_AUTO, 'MacIntel'), true);
    assert.equal(isSameResolvedTerminalFont('dejavu-sans-mono', TERMINAL_FONT_AUTO, 'Linux'), true);
  });

  it('reports a real change when a different font is selected', () => {
    assert.equal(isSameResolvedTerminalFont('jetbrains-mono', TERMINAL_FONT_AUTO, 'Win32'), false);
  });

  it('compares concrete ids directly', () => {
    assert.equal(isSameResolvedTerminalFont('fira-code', 'fira-code', 'Win32'), true);
    assert.equal(isSameResolvedTerminalFont('fira-code', 'menlo', 'Win32'), false);
  });
});

describe('detectFontPlatform', () => {
  it('maps navigator.platform Windows values to win32', () => {
    assert.equal(detectFontPlatform('Win32'), 'win32');
    assert.equal(detectFontPlatform('Windows'), 'win32');
  });

  it('maps macOS and iOS values to darwin', () => {
    assert.equal(detectFontPlatform('MacIntel'), 'darwin');
    assert.equal(detectFontPlatform('iPhone'), 'darwin');
  });

  it('treats everything else (incl. Linux) as linux', () => {
    assert.equal(detectFontPlatform('Linux x86_64'), 'linux');
    assert.equal(detectFontPlatform(''), 'linux');
  });
});
