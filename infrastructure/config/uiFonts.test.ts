import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUiPlatform,
  withWindowsEmojiFallback,
  WINDOWS_FLAG_EMOJI_FONT,
  WINDOWS_UI_EMOJI_FONTS,
  withUiCjkFallback,
} from './uiFonts';

describe('detectUiPlatform', () => {
  it('detects Windows user agents', () => {
    assert.equal(
      detectUiPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'),
      'win32',
    );
  });

  it('detects macOS user agents', () => {
    assert.equal(
      detectUiPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36'),
      'darwin',
    );
  });

  it('falls back to linux for other platforms', () => {
    assert.equal(
      detectUiPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'),
      'linux',
    );
  });
});

describe('withWindowsEmojiFallback', () => {
  const sampleFamily = '"Space Grotesk", system-ui, sans-serif';

  it('prepends bundled flag font and Windows emoji fonts for host labels', () => {
    const stack = withWindowsEmojiFallback(sampleFamily, 'win32');
    assert.ok(stack.startsWith(WINDOWS_UI_EMOJI_FONTS));
    assert.match(stack, /Noto Color Emoji Flags/);
    assert.match(stack, /Space Grotesk/);
  });

  it('includes the bundled flag font before Segoe UI Emoji on Windows', () => {
    const stack = withWindowsEmojiFallback(sampleFamily, 'win32');
    const flagIndex = stack.indexOf(WINDOWS_FLAG_EMOJI_FONT);
    const segoeIndex = stack.indexOf('Segoe UI Emoji');
    assert.ok(flagIndex >= 0);
    assert.ok(segoeIndex >= 0);
    assert.ok(flagIndex < segoeIndex);
  });

  it('keeps the stack unchanged on non-Windows platforms', () => {
    assert.equal(withWindowsEmojiFallback(sampleFamily, 'darwin'), sampleFamily);
    assert.equal(withWindowsEmojiFallback(sampleFamily, 'linux'), sampleFamily);
  });

  it('does not double-prepend when emoji fonts are already present', () => {
    const alreadyPrefixed = `${WINDOWS_UI_EMOJI_FONTS}, ${sampleFamily}`;
    assert.equal(withWindowsEmojiFallback(alreadyPrefixed, 'win32'), alreadyPrefixed);
  });
});

describe('withUiCjkFallback', () => {
  it('still appends CJK fallbacks for UI font stacks', () => {
    const stack = withUiCjkFallback('"Space Grotesk", system-ui');
    assert.match(stack, /PingFang SC/);
    assert.match(stack, /Space Grotesk/);
  });
});
