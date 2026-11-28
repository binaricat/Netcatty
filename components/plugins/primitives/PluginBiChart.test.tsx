import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'SVGElement',
    'Node',
    'NodeFilter',
    'MutationObserver',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'XMLSerializer',
  ]) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 640, 320);

  return {
    dom,
    cleanup() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('PluginBiChart renders all 10 chart types, supports datumClick cross-filtering, legend toggle, activeFilter, and SVG export', async () => {
  const env = installDom();
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginBiChart, formatBiValue } = await import('./PluginBiChart');

  assert.equal(formatBiValue(12500, 'currency', 'USD'), '$12.5K');
  assert.equal(formatBiValue(0.425, 'percent'), '42.5%');
  assert.equal(formatBiValue(2048, 'bytes'), '2.0 KiB');
  assert.equal(formatBiValue(1500, 'ms'), '1.50 s');
  assert.equal(formatBiValue(Number.NaN), '--');

  const root = createRoot(document.getElementById('root')!);
  const events: Array<{ name: string; detail?: Record<string, unknown> }> = [];
  const onWidgetEvent = (name: string, detail?: Record<string, unknown>) => {
    events.push({ name, detail });
  };

  try {
    const cartesianTypes = ['bar', 'horizontal-bar', 'stacked-bar', 'line', 'area', 'combo'] as const;
    for (const type of cartesianTypes) {
      await act(async () => {
        root.render(
          <PluginBiChart
            type={type}
            title={`Test ${type}`}
            categories={['APAC', 'EMEA', 'NA']}
            series={[
              { id: 'rev', name: 'Revenue', data: [1200, 1800, 2400], renderAs: 'bar', yAxis: 'left', color: 'sky', format: 'currency', currency: 'USD' },
              { id: 'orders', name: 'Orders', data: [42, 68, 95], renderAs: 'line', yAxis: 'right', color: 'amber', format: 'compact' },
            ]}
            xAxisLabel="Region"
            yAxisLabel="Revenue"
            yAxisRightLabel="Orders"
            showDataLabels
            smooth
            onWidgetEvent={onWidgetEvent}
          />,
        );
      });
      assert.ok(document.querySelector(`[data-plugin-bi-chart="${type}"] svg`), `${type} should render an SVG`);
      assert.ok(document.querySelector('[data-bi-datum="0:1"]'), `${type} should render clickable datum markers`);
    }

    // Click datum on combo chart and verify cross-filter event payload
    events.length = 0;
    const datum = document.querySelector<SVGElement>('[data-bi-datum="0:1"]')!;
    await act(async () => {
      datum.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'datumClick');
    assert.deepEqual(events[0].detail, {
      seriesIndex: 0,
      seriesName: 'Revenue',
      datumIndex: 1,
      category: 'EMEA',
      value: 1800,
    });

    // Toggle legend series locally and verify series hides
    const legendBtn = document.querySelector<HTMLButtonElement>('[data-bi-legend-series="orders"]')!;
    assert.equal(legendBtn.getAttribute('aria-pressed'), 'true');
    await act(async () => {
      legendBtn.click();
    });
    assert.equal(legendBtn.getAttribute('aria-pressed'), 'false');

    // Pie, Donut, Funnel, Scatter + activeFilter dimming + SVG export
    for (const type of ['pie', 'donut', 'funnel'] as const) {
      await act(async () => {
        root.render(
          <PluginBiChart
            type={type}
            title={`Test ${type}`}
            categories={['Visited', 'Signed Up', 'Paid']}
            series={[{ id: 's', name: 'Users', data: [1000, 420, 110] }]}
            activeFilter={{ category: 'Signed Up' }}
            showDataLabels
            onWidgetEvent={onWidgetEvent}
          />,
        );
      });
      const matchedEl = document.querySelector<SVGElement>('[data-bi-datum="0:1"]')!;
      const dimmedEl = document.querySelector<SVGElement>('[data-bi-datum="0:0"]')!;
      assert.ok(Number(matchedEl.getAttribute('opacity')) > 0.8, `${type} matched datum stays bright`);
      assert.ok(Number(dimmedEl.getAttribute('opacity')) < 0.4, `${type} non-matched datum dims`);
    }

    // Scatter with bubble size + NaN/Infinity filtering
    await act(async () => {
      root.render(
        <PluginBiChart
          type="scatter"
          title="Latency vs Throughput"
          series={[
            {
              id: 'nodes',
              name: 'Nodes',
              points: [
                { x: 10, y: 200, label: 'node-a', size: 8 },
                { x: Number.NaN, y: 100, label: 'bad' },
                { x: 25, y: 450, label: 'node-b', size: 99 },
              ],
            },
          ]}
          onWidgetEvent={onWidgetEvent}
        />,
      );
    });
    const scatterDots = document.querySelectorAll('[data-bi-datum]');
    assert.equal(scatterDots.length, 2, 'scatter filters out non-finite points');
    assert.equal(scatterDots[1].getAttribute('r'), '14', 'bubble radius clamps at 14');

    // Export SVG emits bounded standalone SVG string
    events.length = 0;
    const exportSvgBtn = document.querySelector<HTMLButtonElement>('[data-bi-export-svg]')!;
    await act(async () => {
      exportSvgBtn.click();
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'exportSvg');
    assert.match(String(events[0].detail?.svg), /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(events[0].detail?.suggestedName, 'latency-vs-throughput.svg');

    // Empty state
    await act(async () => {
      root.render(
        <PluginBiChart
          type="bar"
          categories={[]}
          series={[]}
          emptyText="Nothing to chart"
          onWidgetEvent={onWidgetEvent}
        />,
      );
    });
    assert.match(document.body.textContent ?? '', /Nothing to chart/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    env.cleanup();
  }
});
