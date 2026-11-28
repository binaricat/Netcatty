import test from 'node:test';
import assert from 'node:assert/strict';
import { createCattyToolsFromCatalog, withCattyToolContext } from './capabilityTools';
import { buildCattyToolApproval } from './cattyToolApproval';
import { buildSystemPrompt } from '../cattyAgent/systemPrompt';
import type { PluginAISidebarToolSpec } from '../pluginAiSidebarTypes';

const samplePluginTools: PluginAISidebarToolSpec[] = [
  {
    pluginId: 'com.binaricat.netcatty-database',
    pluginName: 'Netcatty Database',
    name: 'db_create_bi_chart',
    qualifiedName: 'plugin_abc123_db_create_bi_chart',
    description: 'Run read-only SQL and render an inline BI chart',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
    risk: 'read',
    viewId: 'com.binaricat.netcatty-database.workbench',
  },
  {
    pluginId: 'com.binaricat.netcatty-database',
    pluginName: 'Netcatty Database',
    name: 'db_pin_chart_to_dashboard',
    qualifiedName: 'plugin_abc123_db_pin_chart_to_dashboard',
    description: 'Pin a BI chart card to the active connection dashboard',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    risk: 'write',
    viewId: 'com.binaricat.netcatty-database.workbench',
  },
];

test('createCattyToolsFromCatalog injects plugin tools, host-stamps artifacts, and summarizes model output', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const bridge = {
    invokePluginAiTool: async (payload: Record<string, unknown>) => {
      calls.push(payload);
      return {
        ok: true,
        rowCount: 2,
        _netcattyArtifact: {
          kind: 'bi-chart',
          _netcattyPluginId: 'com.evil.spoofed',
          title: 'Sales',
          chartSpec: {
            type: 'bar',
            categories: ['Q1', 'Q2'],
            series: [{ id: 's1', name: 'Rev', values: [10, 20] }],
          },
        },
      };
    },
  };

  const bundle = createCattyToolsFromCatalog(
    bridge as never,
    () => ({ sessions: [] }),
    [],
    'confirm',
    undefined,
    'chat-1',
    undefined,
    undefined,
    { pluginTools: samplePluginTools },
  );

  const chartTool = bundle.tools['plugin_abc123_db_create_bi_chart'];
  assert.ok(chartTool, 'qualified plugin tool should be registered');
  assert.equal(bundle.dynamicToolPolicies?.get('plugin_abc123_db_create_bi_chart')?.write, false);
  assert.equal(bundle.dynamicToolPolicies?.get('plugin_abc123_db_pin_chart_to_dashboard')?.write, true);

  const wrapped = withCattyToolContext(
    chartTool as never,
    bundle.toolsContext['plugin_abc123_db_create_bi_chart'],
  );
  const rawResult = await (wrapped.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>)({
    sql: 'SELECT 1',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginId, 'com.binaricat.netcatty-database');
  assert.equal(calls[0].toolName, 'db_create_bi_chart');

  // Host stamps pluginId over any spoofed plugin value
  const artifact = rawResult._netcattyArtifact as Record<string, unknown>;
  assert.equal(artifact._netcattyPluginId, 'com.binaricat.netcatty-database');
  assert.equal(artifact._netcattyViewId, 'com.binaricat.netcatty-database.workbench');
  assert.equal(artifact._netcattyToolName, 'db_create_bi_chart');

  // Global tool (no spec.viewId) strips any plugin-spoofed _netcattyViewId
  const globalBundle = createCattyToolsFromCatalog(
    {
      invokePluginAiTool: async () => ({
        ok: true,
        _netcattyArtifact: {
          kind: 'sql-result',
          _netcattyPluginId: 'com.evil.spoofed',
          _netcattyViewId: 'com.other.victim.view',
          _netcattyToolName: 'spoofed_tool',
          sql: 'SELECT 1',
          columns: ['a'],
          rows: [[1]],
          rowCount: 1,
        },
      }),
    } as never,
    () => ({ sessions: [] }),
    [],
    'confirm',
    undefined,
    'chat-1',
    undefined,
    undefined,
    {
      pluginTools: [{
        pluginId: 'com.binaricat.netcatty-database',
        pluginName: 'Netcatty Database',
        name: 'db_run_readonly_sql',
        qualifiedName: 'plugin_abc123_db_run_readonly_sql',
        description: 'Run SQL',
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
      }],
    },
  );
  const wrappedGlobal = withCattyToolContext(
    globalBundle.tools['plugin_abc123_db_run_readonly_sql'] as never,
    globalBundle.toolsContext['plugin_abc123_db_run_readonly_sql'],
  );
  const globalRes = await (wrappedGlobal.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>)({});
  const globalArtifact = globalRes._netcattyArtifact as Record<string, unknown>;
  assert.equal(globalArtifact._netcattyPluginId, 'com.binaricat.netcatty-database');
  assert.equal(globalArtifact._netcattyViewId, undefined);
  assert.equal(globalArtifact._netcattyToolName, 'db_run_readonly_sql');

  // toModelOutput omits bulky chartSpec arrays while confirming inline render
  const modelOutput = (chartTool as { toModelOutput?: (arg: { output: unknown }) => { type: string; value: string } })
    .toModelOutput?.({ output: rawResult });
  assert.ok(modelOutput && modelOutput.type === 'text');
  const parsedModelOutput = JSON.parse(modelOutput.value) as Record<string, unknown>;
  assert.equal(parsedModelOutput._netcattyArtifact, undefined);
  assert.equal((parsedModelOutput._netcattyArtifactSummary as Record<string, unknown>)?.renderedInline, true);
});

test('buildCattyToolApproval enforces read vs write policies for dynamic plugin tools', async () => {
  const dynamicToolPolicies = new Map([
    ['plugin_abc123_db_create_bi_chart', { write: false, capabilityId: 'plugin.ai.tool:com.binaricat.netcatty-database:db_create_bi_chart' }],
    ['plugin_abc123_db_pin_chart_to_dashboard', { write: true, capabilityId: 'plugin.ai.tool:com.binaricat.netcatty-database:db_pin_chart_to_dashboard' }],
  ]);

  const observerApproval = buildCattyToolApproval({
    permissionMode: 'observer',
    chatSessionId: 'chat-1',
    dynamicToolPolicies,
  }) as (arg: { toolCall: { toolCallId: string; toolName: string; input: Record<string, unknown> } }) => Promise<unknown>;

  assert.equal(
    await observerApproval({ toolCall: { toolCallId: 'c1', toolName: 'plugin_abc123_db_create_bi_chart', input: {} } }),
    undefined,
  );
  const observerDenied = await observerApproval({
    toolCall: { toolCallId: 'c2', toolName: 'plugin_abc123_db_pin_chart_to_dashboard', input: {} },
  }) as { type: string };
  assert.equal(observerDenied.type, 'denied');

  let promptedCapability = '';
  const confirmApproval = buildCattyToolApproval({
    permissionMode: 'confirm',
    chatSessionId: 'chat-1',
    dynamicToolPolicies,
    requestApproval: async (_id, _name, _args, _chatId, _reason, capId) => {
      promptedCapability = capId ?? '';
      return true;
    },
  }) as (arg: { toolCall: { toolCallId: string; toolName: string; input: Record<string, unknown> } }) => Promise<unknown>;

  const confirmResult = await confirmApproval({
    toolCall: { toolCallId: 'c3', toolName: 'plugin_abc123_db_pin_chart_to_dashboard', input: { title: 'Sales' } },
  }) as { type: string };
  assert.equal(confirmResult.type, 'approved');
  assert.equal(promptedCapability, 'plugin.ai.tool:com.binaricat.netcatty-database:db_pin_chart_to_dashboard');
});

test('buildSystemPrompt frames plugin context summary as untrusted data', () => {
  const prompt = buildSystemPrompt({
    scopeType: 'global',
    scopeLabel: 'Netcatty Database',
    hosts: [],
    permissionMode: 'confirm',
    pluginContext: {
      pluginId: 'com.binaricat.netcatty-database',
      pluginName: 'Netcatty Database',
      viewId: 'com.binaricat.netcatty-database.workbench',
      title: 'Sample SQLite',
      subtitle: '5 tables',
      summary: 'Tables: orders, customers',
      tools: samplePluginTools,
    },
  });
  assert.ok(prompt.includes('## Active Plugin View: Netcatty Database — Sample SQLite'));
  assert.ok(prompt.includes('<plugin-context-data>\nTables: orders, customers\n</plugin-context-data>'));
  assert.ok(prompt.includes('plugin_abc123_db_create_bi_chart'));
  assert.ok(prompt.includes('untrusted data'));
});
