import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { parsePluginToolArtifact } from './pluginToolArtifact';
import { PluginArtifactToolResult } from './PluginArtifactToolResult';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://netcatty.local/',
  });
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    SVGElement: globalThis.SVGElement,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'SVGElement', { value: dom.window.SVGElement, configurable: true });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    Object.defineProperty(globalThis, 'window', { value: prev.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: prev.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: prev.navigator, configurable: true });
    Object.defineProperty(globalThis, 'HTMLElement', { value: prev.HTMLElement, configurable: true });
    Object.defineProperty(globalThis, 'SVGElement', { value: prev.SVGElement, configurable: true });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  };
}

test('parsePluginToolArtifact parses bi-chart and sql-result payloads and rejects spoofed or invalid ones', () => {
  const chartPayload = JSON.stringify({
    ok: true,
    _netcattyArtifact: {
      kind: 'bi-chart',
      _netcattyPluginId: 'com.binaricat.netcatty-database',
      _netcattyViewId: 'com.binaricat.netcatty-database.workbench',
      _netcattyToolName: 'db_create_bi_chart',
      title: 'Revenue by Region',
      chartSpec: {
        type: 'bar',
        categories: ['NA', 'EU'],
        series: [{ id: 'rev', name: 'Revenue', values: [120, 95] }],
      },
      kpis: [{ label: 'Total', value: '$215', tone: 'positive' }],
      sql: 'SELECT region, SUM(revenue) FROM sales GROUP BY region',
      pinAction: { toolName: 'db_pin_chart_to_dashboard', args: { title: 'Revenue by Region' } },
    },
  });
  const chart = parsePluginToolArtifact('plugin_abc123_db_create_bi_chart', chartPayload);
  assert.equal(chart?.kind, 'bi-chart');
  assert.equal(chart?.pluginId, 'com.binaricat.netcatty-database');
  assert.equal(chart?.kpis?.length, 1);
  assert.equal(chart?.pinAction?.toolName, 'db_pin_chart_to_dashboard');

  // Non-plugin tools (e.g. terminal_execute, sftp_read) cannot spoof _netcattyArtifact
  assert.equal(parsePluginToolArtifact('terminal_execute', chartPayload), null);
  assert.equal(parsePluginToolArtifact('web_search', chartPayload), null);
  // Mismatched _netcattyToolName vs qualified tool suffix is rejected
  assert.equal(parsePluginToolArtifact('plugin_abc123_other_tool', chartPayload), null);

  const sql = parsePluginToolArtifact('plugin_abc123_db_run_readonly_sql', {
    _netcattyArtifact: {
      kind: 'sql-result',
      _netcattyPluginId: 'com.binaricat.netcatty-database',
      _netcattyToolName: 'db_run_readonly_sql',
      sql: 'SELECT id, name FROM users LIMIT 2',
      columns: ['id', 'name'],
      rows: [[1, 'Alice'], [2, 'Bob']],
      rowCount: 2,
      durationMs: 4,
      openAction: { toolName: 'db_open_sql_tab', args: { sql: 'SELECT id, name FROM users' } },
    },
  });
  assert.equal(sql?.kind, 'sql-result');
  assert.equal(sql?.rows.length, 2);
  assert.equal(sql?.openAction?.toolName, 'db_open_sql_tab');

  // Error results and unknown chart types are rejected
  assert.equal(parsePluginToolArtifact('plugin_abc123_db_create_bi_chart', { _netcattyArtifact: { kind: 'bi-chart', _netcattyPluginId: 'com.a.b', _netcattyToolName: 'db_create_bi_chart', chartSpec: { type: 'bar', series: [{ id: 'a', name: 'A', values: [1] }] } } }, true), null);
  assert.equal(parsePluginToolArtifact('plugin_abc123_db_create_bi_chart', { _netcattyArtifact: { kind: 'bi-chart', _netcattyPluginId: 'com.a.b', _netcattyToolName: 'db_create_bi_chart', chartSpec: { type: 'invalid', series: [{ id: 'a', name: 'A', values: [1] }] } } }), null);
});

test('PluginArtifactToolResult renders inline PluginBiChart and invokes pinAction via netcatty bridge', async () => {
  const cleanup = installDom();
  const invoked: Array<Record<string, unknown>> = [];
  (window as unknown as { netcatty?: Record<string, unknown> }).netcatty = {
    invokePluginAiTool: async (payload: Record<string, unknown>) => {
      invoked.push(payload);
      return { ok: true };
    },
  };

  const artifact = parsePluginToolArtifact('plugin_abc123_db_create_bi_chart', {
    _netcattyArtifact: {
      kind: 'bi-chart',
      _netcattyPluginId: 'com.binaricat.netcatty-database',
      _netcattyViewId: 'com.binaricat.netcatty-database.workbench',
      _netcattyToolName: 'db_create_bi_chart',
      title: 'Top Products',
      chartSpec: {
        type: 'bar',
        categories: ['Pro', 'Air'],
        series: [{ id: 'rev', name: 'Revenue', values: [4200, 3100] }],
      },
      kpis: [{ label: 'Total Revenue', value: '$7.3K', tone: 'positive' }],
      sql: 'SELECT product, SUM(revenue) FROM orders GROUP BY product',
      pinAction: {
        toolName: 'db_pin_chart_to_dashboard',
        args: { title: 'Top Products' },
      },
    },
  });
  assert.ok(artifact);

  const container = document.getElementById('root')!;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(PluginArtifactToolResult, { artifact }));
    });
    assert.ok(container.querySelector('[data-plugin-ai-artifact="bi-chart"]'));
    assert.ok(container.querySelector('svg'), 'PluginBiChart SVG should render inline');
    assert.ok(container.textContent?.includes('$7.3K'));

    const pinButton = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Pin to BI Dashboard'),
    );
    assert.ok(pinButton, 'Pin to BI Dashboard button should render');
    await act(async () => {
      pinButton.click();
    });
    assert.equal(invoked.length, 1);
    assert.deepEqual(invoked[0], {
      pluginId: 'com.binaricat.netcatty-database',
      toolName: 'db_pin_chart_to_dashboard',
      args: { title: 'Top Products' },
      viewId: 'com.binaricat.netcatty-database.workbench',
    });
    assert.ok(container.textContent?.includes('Pinned'));
  } finally {
    await act(async () => {
      root.unmount();
    });
    cleanup();
  }
});
