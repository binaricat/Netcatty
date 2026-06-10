import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBoldWeightDistinctWithContext,
  pickNearestBundledWeight,
  resolveFontWeightBold,
} from './fontWeightAvailability';

function makeWeightContext(weightsByFamily: Record<string, Partial<Record<number, number>>>) {
  return {
    measureText: (font: string, text: string) => {
      const match = font.match(/^(\d+)\s+\d+px\s+"?([^",]+)"?,/);
      const weight = match ? Number(match[1]) : 400;
      const family = match?.[2] ?? '';
      const width = weightsByFamily[family]?.[weight] ?? weightsByFamily[family]?.[400] ?? 100;
      return {
        width: width * text.length,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 2,
      } as TextMetrics;
    },
  };
}

describe('pickNearestBundledWeight', () => {
  it('returns the desired weight when bundled', () => {
    assert.equal(pickNearestBundledWeight([400, 500, 600], 600, 400), 600);
  });

  it('falls back to the nearest heavier bundled weight', () => {
    assert.equal(pickNearestBundledWeight([400, 500, 600], 700, 400), 600);
  });

  it('returns normal weight when nothing heavier is bundled', () => {
    assert.equal(pickNearestBundledWeight([400], 700, 400), 400);
  });
});

describe('isBoldWeightDistinctWithContext', () => {
  it('detects a real bold face via width differences', () => {
    const ctx = makeWeightContext({
      Menlo: { 400: 10, 700: 12 },
    });
    assert.equal(isBoldWeightDistinctWithContext('Menlo', 400, 700, 14, ctx), true);
  });

  it('detects a real bold face via ascent differences', () => {
    const ctx = {
      measureText: (font: string, text: string) => {
        const isBold = font.startsWith('700 ');
        return {
          width: text.length * 10,
          actualBoundingBoxAscent: isBold ? 12 : 10,
          actualBoundingBoxDescent: 2,
        } as TextMetrics;
      },
    };
    assert.equal(isBoldWeightDistinctWithContext('Menlo', 400, 700, 14, ctx), true);
  });

  it('rejects unavailable bold weights that collapse to the normal face', () => {
    const ctx = makeWeightContext({
      Menlo: { 400: 10, 700: 10 },
    });
    assert.equal(isBoldWeightDistinctWithContext('Menlo', 400, 700, 14, ctx), false);
  });
});

describe('resolveFontWeightBold', () => {
  it('caps bundled JetBrains Mono bold at 600 when 700 is requested', () => {
    assert.equal(
      resolveFontWeightBold({
        fontFamilyCss: '"JetBrains Mono", monospace',
        normalWeight: 400,
        desiredBoldWeight: 700,
        fontSize: 14,
      }),
      600,
    );
  });

  it('returns normal weight when bold is not heavier than normal', () => {
    assert.equal(
      resolveFontWeightBold({
        fontFamilyCss: '"JetBrains Mono", monospace',
        normalWeight: 600,
        desiredBoldWeight: 500,
        fontSize: 14,
      }),
      600,
    );
  });
});
