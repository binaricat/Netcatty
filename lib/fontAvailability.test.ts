import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPrimaryFamily,
  detectInstalledWithContext,
  isFontInstalled,
  setSystemFamilies,
  hasAuthoritativeData,
  clearFontAvailabilityCache,
  subscribeFontAvailability,
  getFontAvailabilityVersion,
  bundledFamiliesInStack,
} from './fontAvailability';

describe('bundledFamiliesInStack', () => {
  it('returns bundled webfonts present in a composed stack, in order', () => {
    const stack = 'Consolas, "JetBrains Mono", "Sarasa Mono SC", monospace';
    assert.deepEqual(bundledFamiliesInStack(stack), ['JetBrains Mono', 'Sarasa Mono SC']);
  });

  it('returns nothing when only system fonts are referenced', () => {
    assert.deepEqual(bundledFamiliesInStack('Menlo, monospace'), []);
  });

  it('ignores the generic monospace keyword and dedupes', () => {
    const stack = '"JetBrains Mono", "JetBrains Mono", monospace';
    assert.deepEqual(bundledFamiliesInStack(stack), ['JetBrains Mono']);
  });

  it('is case-insensitive on family names', () => {
    assert.deepEqual(bundledFamiliesInStack('"jetbrains mono"'), ['JetBrains Mono']);
  });
});

describe('extractPrimaryFamily', () => {
  it('strips quotes from a quoted name', () => {
    assert.equal(extractPrimaryFamily('"Fira Code", monospace'), 'Fira Code');
  });
  it('returns unquoted single-word names as-is', () => {
    assert.equal(extractPrimaryFamily('Menlo, monospace'), 'Menlo');
  });
  it('returns the first family in a list', () => {
    assert.equal(
      extractPrimaryFamily('"Source Code Pro", "Fira Code", monospace'),
      'Source Code Pro',
    );
  });
  it('handles a single name without comma', () => {
    assert.equal(extractPrimaryFamily('Iosevka'), 'Iosevka');
  });
});

function makeContextWithInstalledFamilies(installed: Set<string>) {
  // Mock canvas measurement: each generic fallback has a stable width;
  // a "real" installed font produces a different width per fallback.
  // Collision-resistant: position-weighted polynomial hash.
  const widthFor = (family: string): number => {
    let h = 0;
    for (let i = 0; i < family.length; i++) {
      h = (h * 31 + family.charCodeAt(i)) >>> 0;
    }
    return 100 + (h % 9973);
  };
  return {
    measureText: (font: string, _text: string) => {
      const match = font.match(/^\d+px\s+(.+)$/);
      if (!match) return 0;
      const familyList = match[1];
      const families = familyList
        .split(',')
        .map((f) => f.trim().replace(/^["']|["']$/g, ''));
      for (const f of families) {
        if (installed.has(f) || ['serif', 'sans-serif', 'monospace'].includes(f)) {
          return widthFor(f);
        }
      }
      return 0;
    },
  };
}

describe('detectInstalledWithContext (canvas fallback)', () => {
  it('detects an installed font (width differs from all 3 generic fallbacks)', () => {
    const ctx = makeContextWithInstalledFamilies(new Set(['Fira Code']));
    assert.equal(detectInstalledWithContext('Fira Code', ctx), true);
  });

  it('rejects a non-installed font (falls through to fallback)', () => {
    const ctx = makeContextWithInstalledFamilies(new Set(['Fira Code']));
    assert.equal(detectInstalledWithContext('Definitely Not A Font', ctx), false);
  });

  it('treats KNOWN_BUNDLED_FAMILIES as installed regardless of canvas evidence', () => {
    const ctx = makeContextWithInstalledFamilies(new Set());
    assert.equal(detectInstalledWithContext('JetBrains Mono', ctx), true);
    assert.equal(detectInstalledWithContext('Sarasa Mono SC', ctx), true);
  });

  it('treats a font as installed when it matches one generic but differs from the others', () => {
    // Regression guard for codex P2 review on PR #940: on macOS the
    // `monospace` generic resolves to Menlo, so measure(`"Menlo", monospace`)
    // equals measure(`monospace`). The detector must NOT report Menlo
    // as uninstalled just because of that single collision — it should
    // recognize installation via the other two generic baselines.
    const ctx = {
      measureText: (font: string): number => {
        // "Menlo", X → Menlo's metrics (always 100, regardless of fallback)
        if (font.includes('"Menlo"')) return 100;
        // Generic baselines
        if (font === '72px serif') return 50;
        if (font === '72px sans-serif') return 80;
        if (font === '72px monospace') return 100; // identical to Menlo
        // Unknown family followed by a generic → falls to that generic
        const tail = font.split(',').pop()?.trim() ?? '';
        if (tail === 'serif') return 50;
        if (tail === 'sans-serif') return 80;
        if (tail === 'monospace') return 100;
        return 0;
      },
    };
    assert.equal(detectInstalledWithContext('Menlo', ctx), true);
  });

  it('still reports a clearly-uninstalled font as missing even with the looser rule', () => {
    // "Some" semantics must not introduce false positives for fonts
    // that genuinely aren't installed — those fall through to each
    // generic and match all three baselines.
    const ctx = makeContextWithInstalledFamilies(new Set(['Menlo']));
    assert.equal(detectInstalledWithContext('Definitely Not Installed', ctx), false);
  });
});

describe('isFontInstalled with authoritative system data', () => {
  beforeEach(() => {
    clearFontAvailabilityCache();
  });

  it('returns true for bundled families even without authoritative data', () => {
    assert.equal(hasAuthoritativeData(), false);
    assert.equal(isFontInstalled('JetBrains Mono'), true);
    assert.equal(isFontInstalled('Sarasa Mono SC'), true);
  });

  it('answers from authoritative set once setSystemFamilies has run', () => {
    setSystemFamilies(new Set(['menlo', 'fira code']));
    assert.equal(hasAuthoritativeData(), true);
    assert.equal(isFontInstalled('Menlo'), true);
    assert.equal(isFontInstalled('Fira Code'), true);
    assert.equal(isFontInstalled('Sarasa Mono SC'), true, 'bundled wins over set');
    assert.equal(isFontInstalled('PingFang SC'), false, 'not in authoritative set');
    assert.equal(isFontInstalled('Programmer Fonts'), false, 'fictitious name');
  });

  it('lookup is case-insensitive (set stores lowercase)', () => {
    setSystemFamilies(new Set(['microsoft yahei ui']));
    assert.equal(isFontInstalled('Microsoft YaHei UI'), true);
    assert.equal(isFontInstalled('MICROSOFT YAHEI UI'), true);
  });

  it('falls back to safe-default (true) without DOM and without authoritative data', () => {
    assert.equal(hasAuthoritativeData(), false);
    assert.equal(isFontInstalled('Some Unknown Font'), true);
  });

  it('a null authoritative set means we re-enter fallback mode', () => {
    setSystemFamilies(new Set(['menlo']));
    assert.equal(hasAuthoritativeData(), true);
    setSystemFamilies(null);
    assert.equal(hasAuthoritativeData(), false);
  });
});

describe('font availability subscription', () => {
  beforeEach(() => {
    clearFontAvailabilityCache();
  });

  it('notifies subscribers when setSystemFamilies is called', () => {
    // Regression guard for codex P2 review on PR #940:
    // TerminalCjkFontSelect memoizes visibleOptions on [value] but the
    // filter calls isFontInstalled which depends on systemFamilies.
    // Subscribers wired via useSyncExternalStore must fire so memos
    // recompute when authoritative data arrives.
    let calls = 0;
    const unsubscribe = subscribeFontAvailability(() => {
      calls += 1;
    });

    setSystemFamilies(new Set(['menlo']));
    assert.equal(calls, 1);

    setSystemFamilies(new Set(['menlo', 'fira code']));
    assert.equal(calls, 2);

    setSystemFamilies(null);
    assert.equal(calls, 3);

    unsubscribe();
    setSystemFamilies(new Set(['menlo']));
    assert.equal(calls, 3, 'unsubscribe stops notifications');
  });

  it('version monotonically increases on each setSystemFamilies call', () => {
    const v0 = getFontAvailabilityVersion();
    setSystemFamilies(new Set(['menlo']));
    const v1 = getFontAvailabilityVersion();
    setSystemFamilies(new Set(['menlo', 'fira code']));
    const v2 = getFontAvailabilityVersion();

    assert.ok(v1 > v0, 'first call bumps version');
    assert.ok(v2 > v1, 'second call bumps version');
  });

  it('clearFontAvailabilityCache also notifies subscribers', () => {
    let calls = 0;
    subscribeFontAvailability(() => {
      calls += 1;
    });
    setSystemFamilies(new Set(['menlo']));
    const after = calls;
    clearFontAvailabilityCache();
    assert.ok(calls > after, 'clear notifies too');
  });
});
