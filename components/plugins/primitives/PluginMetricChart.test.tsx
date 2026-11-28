import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginMetricChart, formatMetricValue } from './PluginMetricChart';

test('PluginMetricChart renders area, sparkline, bar, thresholds, and bounds extreme input safely', () => {
  const now = 1_700_000_000_000;
  const html = renderToStaticMarkup(
    React.createElement(PluginMetricChart, {
      variant: 'area',
      height: 160,
      rangeMs: 300_000,
      intervalMs: 5_000,
      endAt: now,
      showLegend: true,
      showAxes: true,
      thresholds: [
        { value: 80, tone: 'warning', label: 'Warn' },
        { value: 95, tone: 'critical', label: 'Crit' },
      ],
      series: [
        {
          id: 'cpu',
          label: 'CPU',
          color: 'sky',
          unit: '%',
          points: [
            { at: now - 15_000, value: 22.5 },
            { at: now - 10_000, value: 48.2 },
            { at: now - 5_000, value: null },
            { at: now, value: 64.0 },
          ],
        },
        {
          id: 'mem',
          label: 'Memory',
          color: 'emerald',
          unit: '%',
          points: [
            { at: now - 15_000, value: 51 },
            { at: now, value: 53 },
          ],
        },
      ],
    }),
  );

  assert.match(html, /role="img"/);
  assert.match(html, /<svg/);
  assert.match(html, /CPU/);
  assert.match(html, /64\.0%/);
  assert.match(html, /Warn/);
  assert.match(html, /Crit/);

  const sparkHtml = renderToStaticMarkup(
    React.createElement(PluginMetricChart, {
      variant: 'sparkline',
      height: 36,
      series: [{ id: 'rx', label: 'RX', unit: 'bytes/s', points: [{ at: now - 5000, value: 1024 }, { at: now, value: 4096 }] }],
    }),
  );
  assert.match(sparkHtml, /<svg/);
  assert.match(sparkHtml, /height:36px/);

  const barHtml = renderToStaticMarkup(
    React.createElement(PluginMetricChart, {
      variant: 'bar',
      series: [{ id: 'load', label: 'Load', unit: 'count', points: [{ at: now - 5000, value: 2 }, { at: now, value: 5 }] }],
    }),
  );
  assert.match(barHtml, /<rect/);

  // Empty state
  const emptyHtml = renderToStaticMarkup(
    React.createElement(PluginMetricChart, {
      variant: 'line',
      series: [{ id: 'empty', label: 'Empty', points: [] }],
      emptyText: 'No metrics yet',
    }),
  );
  assert.match(emptyHtml, /No metrics yet/);
});

test('formatMetricValue formats percent, bytes/s, ms, temp, and count cleanly', () => {
  assert.equal(formatMetricValue(null, '%'), '--');
  assert.equal(formatMetricValue(42.34, '%'), '42.3%');
  assert.equal(formatMetricValue(100, '%'), '100%');
  assert.equal(formatMetricValue(2048, 'bytes/s'), '2.0 KiB/s');
  assert.equal(formatMetricValue(3 * 1024 * 1024, 'bytes/s'), '3.0 MiB/s');
  assert.equal(formatMetricValue(42, 'ms'), '42 ms');
  assert.equal(formatMetricValue(1500, 'ms'), '1.50 s');
  assert.equal(formatMetricValue(63.4, 'temp'), '63.4 C');
  assert.equal(formatMetricValue(2500, 'count'), '2.5k');
});
