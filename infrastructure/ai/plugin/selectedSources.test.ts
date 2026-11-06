import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginAIHostRequest, PluginSelectedContextContent, PluginSelectedContextListResult, PluginSelectedContextRef, PluginSelectedContextSummary } from '@netcatty/plugin-contract';
import type { TerminalSession, Workspace } from '../../../domain/models';
import { buildSelectedPluginSources, type SelectedSnapshot } from './selectedSources';
import { createTrustedPluginAIHostRuntime } from './trustedHostRuntime';

const require = createRequire(import.meta.url);
const { PluginDatabase } = require('../../../electron/plugins/database.cjs');
const { PluginPermissionEngine } = require('../../../electron/plugins/permissionEngine.cjs');
const { PluginAIContextService } = require('../../../electron/plugins/ai/aiContextService.cjs');
const { PluginAITrustedHostAdapter, PLUGIN_AI_HOST_CHANNELS: CHANNELS } = require('../../../electron/plugins/ai/trustedHostAdapter.cjs');
const { PluginHostRpcRegistry } = require('../../../electron/plugins/hostRpcRegistry.cjs');
const { RPC_ERRORS } = require('../../../electron/plugins/rpcRouter.cjs');
const staleContextError = { code: RPC_ERRORS.permissionDenied, message: /^Selected context (changed|is unavailable)$/ };

function fixture(t: TestContext) {
  const a: TerminalSession = { id: 'a', hostId: 'host-a', hostLabel: 'Synthetic A', hostname: 'a.example.invalid', username: 'synthetic-a', status: 'connected' };
  const b: TerminalSession = { id: 'b', hostId: 'host-b', hostLabel: 'Synthetic B', hostname: 'b.example.invalid', username: 'synthetic-b', status: 'connected' };
  const workspace: Workspace = { id: 'workspace', title: 'Synthetic workspace', focusedSessionId: 'a',
    root: { id: 'split', type: 'split', direction: 'horizontal', children: [{ id: 'pane-a', type: 'pane', sessionId: a.id }, { id: 'pane-b', type: 'pane', sessionId: b.id }] } };
  let snapshot: SelectedSnapshot = { activeTabId: workspace.id, sessions: [a, b], workspaces: [workspace],
    note: { id: 'note', title: 'Synthetic Note', content: 'Synthetic Note text', createdAt: 1, updatedAt: 1 } };
  const renderer = createTrustedPluginAIHostRuntime({ getModel: () => null, prepareModel: async () => {}, isActive: () => true,
    chooseSelected: async () => buildSelectedPluginSources(() => snapshot) });
  const requests: string[] = [];
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    send: (channel: string, request: PluginAIHostRequest) => {
      assert.equal(channel, CHANNELS.request); requests.push(request.kind);
      void renderer.handle(request.kind, request.payload, request.runtimeId).then(
        (result) => host.respond(sender, { requestId: request.requestId, actionToken: request.actionToken, result }),
        () => host.respond(sender, { requestId: request.requestId, actionToken: request.actionToken, error: true }),
      ).catch(() => {});
    } });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isVisible: () => true, isFocused: () => true });
  const host = new PluginAITrustedHostAdapter({ getWindow: () => window, isLocked: () => false, cancelProviderStreams: () => {}, timeoutMs: 1000 });
  host.registerIpc({ handle() {}, removeHandler() {} }); host.setReady(sender, true);
  let invoked = 0;
  // Only inference is synthetic; selection, IPC nonce/canonical validation,
  // source ownership, permission middleware and both public RPC routes are real.
  host.selectModel = async () => ({ label: 'Synthetic model', isCurrent: () => true, invoke: async () => {
    invoked++; return (async function* () { yield { kind: 'text', text: 'Synthetic response' }; })();
  } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-selected-focus-'));
  const database = new PluginDatabase(path.join(root, 'plugins.sqlite'));
  const manifest = { manifestVersion: 1, id: 'com.example.selected-focus', name: 'Selected focus fixture', version: '1.0.0', publisher: 'example',
    engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'no-plugin-is-executed.js' },
    features: { required: ['ai.model-invocation', 'context.selected-read'] },
    permissions: { optional: ['ai.invoke', 'context.selected.list', 'context.selected.read'] } };
  database.installVersion({ pluginId: manifest.id, version: manifest.version, manifest, archiveSha256: 'a'.repeat(64), packageRelativePath: 'synthetic' }, { enable: true });
  database.setRuntimeState(manifest.id, 'running', { runtimeKind: 'browser' });
  const identity = { pluginId: manifest.id, pluginVersion: manifest.version, runtimeId: 'synthetic-runtime', runtimeKind: 'browser', manifest };
  const permissions = new PluginPermissionEngine({ database });
  const service = new PluginAIContextService({ database, permissionEngine: permissions, hostAdapter: host, getRuntimeIdentity: () => identity });
  const registry = new PluginHostRpcRegistry(); registry.use(permissions.createMiddleware()); service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes(identity);
  const call = (method: string, params: Record<string, unknown> = {}) => routes.requestHandlers[method](params, { signal: new AbortController().signal });
  const reference = (item: PluginSelectedContextSummary): PluginSelectedContextRef => ({ handle: item.handle, version: item.version });
  t.after(() => { service.shutdown(); host.shutdown(); renderer.shutdown(); permissions.shutdown(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { call, requests, invoked: () => invoked, snapshot: () => snapshot,
    list: async () => (await call('context.selected.list') as PluginSelectedContextListResult).items,
    read: async (item: PluginSelectedContextSummary) => await call('context.selected.read', reference(item)) as PluginSelectedContextContent,
    start: async (item: PluginSelectedContextSummary) => { const chat = await call('ai.openChat'); return call('ai.startTurn', { chatHandle: chat.chatHandle, prompt: 'Synthetic summary', contexts: [reference(item)] }); },
    focus: (id: string) => { snapshot = { ...snapshot, workspaces: snapshot.workspaces.map((item) => ({ ...item, focusedSessionId: id })) }; },
    updateWorkspace: (change: Partial<Workspace>) => { snapshot = { ...snapshot, workspaces: snapshot.workspaces.map((item) => ({ ...item, ...change })) }; },
  };
}

for (const scope of ['session', 'host']) for (const operation of ['read', 'start']) {
  test(`same-workspace A-to-B focus invalidates selected ${scope} through registered ${operation}`, async (t) => {
    const f = fixture(t); const item = (await f.list()).find((entry) => entry.scope === scope)!;
    assert.equal(JSON.parse((await f.read(item)).text).label, 'Synthetic A');
    const before = f.snapshot(); f.focus('b');
    assert.equal(f.snapshot().activeTabId, before.activeTabId);
    assert.equal(f.snapshot().sessions, before.sessions, 'real focus mutation leaves session objects unchanged');
    await assert.rejects(operation === 'read' ? f.read(item) : f.start(item), staleContextError);
    assert.equal(f.invoked(), 0, 'a stale metadata handle must not reach inference');
    assert.ok(f.requests.includes('context.select') && f.requests.includes('context.current'));
  });
}

test('focus validation remains kind-specific and host re-selection yields current B metadata', async (t) => {
  const f = fixture(t); const items = await f.list();
  const byScope = (scope: string) => items.find((item) => item.scope === scope)!;
  f.updateWorkspace({ viewMode: 'focus' });
  for (const scope of ['session', 'host']) assert.equal(JSON.parse((await f.read(byScope(scope))).text).label, 'Synthetic A');
  await assert.rejects(f.read(byScope('workspace')), staleContextError, 'existing workspace revision semantics remain');
  f.focus('b');
  for (const scope of ['session', 'host']) await assert.rejects(f.read(byScope(scope)), staleContextError);
  assert.equal(JSON.parse((await f.read(byScope('tab'))).text).kind, 'workspace', 'the workspace tab remains selected');
  assert.equal((await f.read(byScope('note'))).text, 'Synthetic Note text', 'explicit Note choice is independent of terminal focus');
  const fresh = await f.list();
  for (const scope of ['session', 'host']) {
    const item = fresh.find((entry) => entry.scope === scope)!;
    assert.notEqual(item.handle, byScope(scope).handle);
    assert.equal(JSON.parse((await f.read(item)).text).label, 'Synthetic B');
  }
  await f.start(fresh.find((entry) => entry.scope === 'session')!);
  assert.equal(f.invoked(), 1, 'fresh current context still reaches the synthetic model through the registered route');
});

test('implicit first-pane fallback is re-resolved when the selected workspace pane changes', async (t) => {
  const f = fixture(t); f.updateWorkspace({ focusedSessionId: undefined });
  const item = (await f.list()).find((entry) => entry.scope === 'session')!;
  assert.equal(JSON.parse((await f.read(item)).text).label, 'Synthetic A');
  f.focus('b'); await assert.rejects(f.read(item), staleContextError);
});
