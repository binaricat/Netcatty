import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllSystemFontFamilies,
  getAllSystemFontFamilyNames,
  getMonospaceFonts,
  __resetLocalFontsCacheForTesting,
} from './localFonts';

interface MockWindow {
  queryLocalFonts: () => Promise<Array<{ family: string }>>;
}

function installMockWindow(impl: MockWindow['queryLocalFonts']): void {
  (globalThis as unknown as { window: MockWindow }).window = {
    queryLocalFonts: impl,
  };
}

function uninstallMockWindow(): void {
  delete (globalThis as unknown as { window?: MockWindow }).window;
}

describe('queryLocalFonts deduplication', () => {
  beforeEach(() => {
    __resetLocalFontsCacheForTesting();
  });
  afterEach(() => {
    uninstallMockWindow();
    __resetLocalFontsCacheForTesting();
  });

  it('coalesces concurrent calls into a single Local Font Access API invocation', async () => {
    // Regression guard for codex P2 review on PR #940: fontStore.initialize
    // calls getMonospaceFonts() and getAllSystemFontFamilies() in
    // Promise.all; both must share one underlying queryLocalFonts() call,
    // not race and fire two prompts / two requests.
    let callCount = 0;
    installMockWindow(async () => {
      callCount++;
      // Tiny tick so the two callers truly overlap in time.
      await new Promise<void>((r) => setTimeout(r, 5));
      return [
        { family: 'Menlo' },
        { family: 'Fira Code' },
        { family: 'PingFang SC' },
      ];
    });

    const [monoFonts, allFamilies] = await Promise.all([
      getMonospaceFonts(),
      getAllSystemFontFamilies(),
    ]);

    assert.equal(callCount, 1, 'queryLocalFonts must be invoked exactly once');
    assert.ok(allFamilies !== null);
    assert.equal(allFamilies?.has('menlo'), true);
    assert.equal(allFamilies?.has('pingfang sc'), true);
    // Mono filter keeps only the monospace-named family.
    assert.equal(
      monoFonts.some((f) => f.name === 'Fira Code'),
      true,
    );
  });

  it('a second sequential call also reuses the resolved promise (no second API call)', async () => {
    let callCount = 0;
    installMockWindow(async () => {
      callCount++;
      return [{ family: 'Menlo' }];
    });

    await getAllSystemFontFamilies();
    await getAllSystemFontFamilies();
    await getMonospaceFonts();

    assert.equal(callCount, 1);
  });

  it('returns display-ready family names with stable casing and case-insensitive deduplication', async () => {
    installMockWindow(async () => [
      { family: 'PingFang SC' },
      { family: 'pingfang sc' },
      { family: 'Sarasa Mono SC' },
      { family: '  Noto Sans Mono CJK SC  ' },
      { family: '' },
    ]);

    const result = await getAllSystemFontFamilyNames();

    assert.deepEqual(result, [
      'Noto Sans Mono CJK SC',
      'PingFang SC',
      'Sarasa Mono SC',
    ]);
  });

  it('returns null authoritative set when Local Font Access API is unavailable', async () => {
    // No window installed → API path skipped.
    const result = await getAllSystemFontFamilies();
    assert.equal(result, null);
  });

  it('treats an empty desktop font result as unavailable and allows retry', async () => {
    let callCount = 0;
    installMockWindow(async () => {
      callCount++;
      return callCount === 1 ? [] : [{ family: 'PingFang SC' }];
    });

    assert.equal(await getAllSystemFontFamilyNames(), null);
    assert.deepEqual(await getAllSystemFontFamilyNames(), ['PingFang SC']);
    assert.equal(callCount, 2);
  });

  it('retries on the next call after a transient failure (does not sticky-cache empty result)', async () => {
    // Regression guard for codex P2 review on PR #940: queryLocalFonts
    // failure should NOT poison the cache for the rest of the session.
    let callCount = 0;
    installMockWindow(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('transient failure (e.g. LFA permission not ready)');
      }
      return [{ family: 'Menlo' }, { family: 'Fira Code' }];
    });

    const first = await getAllSystemFontFamilies();
    assert.equal(first, null, 'first failure returns null authoritative set');

    // Same module, second invocation: must retry queryLocalFonts.
    const second = await getAllSystemFontFamilies();
    assert.equal(callCount, 2, 'queryLocalFonts retried on next call');
    assert.equal(second?.has('menlo'), true, 'second call sees the fonts');
  });
});
