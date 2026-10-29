import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostDrawnViewMessage, HostDrawnViewOpenRequest } from '@netcatty/plugin-contract';
type Update = Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }> & { viewId: string };
import { PluginViewSessions } from './pluginViewSession';
function fixture() {
  let updates: (data: Update) => void = () => {}; let closed: (data: NetcattyPluginViewClosedEvent) => void = () => {};
  const opened: HostDrawnViewOpenRequest[] = []; const closes: string[] = []; const events: unknown[] = [];
  const bridge = { openHostDrawnPluginView: async (request: HostDrawnViewOpenRequest) => { opened.push(request); return { instanceId: request.instanceId }; },
    closeHostDrawnPluginView: async (id: string) => { closes.push(id); },
    onHostDrawnPluginViewUpdate: (listener: typeof updates) => { updates = listener; return () => {}; },
    onPluginViewClosed: (listener: typeof closed) => { closed = listener; return () => {}; },
    sendHostDrawnPluginViewEvent: async (id: string, event: unknown) => { events.push({ id, event }); } };
  return { bridge, opened, closes, events, update: (data: Update) => updates(data), close: (data: { instanceId: string }) => closed({ ...data, viewId: request.viewId, pluginId: 'com.example', reason: 'test' }) };
}
const request = { viewId: 'com.example.view', scopeId: 'window:one', context: {} };
test('a hidden view resumes its existing state and plugin instance', async () => {
  const f = fixture(); const store = new PluginViewSessions();
  const first = store.acquire('view', f.bridge, request); const id = f.opened[0].instanceId;
  f.update({ kind: 'host-ui.update', viewId: request.viewId, instanceId: id, sequence: 1, css: '', mutations: [[0, '~', { id: 'text', type: 3, data: 'kept' }, 0]] });
  first.release(); const next = store.acquire('view', f.bridge, request);
  assert.equal(next, first); assert.equal(f.opened.length, 1); assert.deepEqual(next.getSnapshot().tree.children[0], { id: 'text', type: 3, data: 'kept' });
  next.release(); store.dispose(); await Promise.resolve(); assert.equal(new Set(f.closes).size, 1);
});
test('host invalidation clears retained content and a reopen creates a new instance', () => {
  const f = fixture(); const store = new PluginViewSessions(); const old = store.acquire('view', f.bridge, request);
  f.close({ instanceId: f.opened[0].instanceId }); assert.equal(old.getSnapshot().error, true); assert.deepEqual(old.getSnapshot().tree.children, []);
  const next = store.acquire('view', f.bridge, request); assert.notEqual(old, next); store.dispose();
});
test('unacknowledged input is not overwritten by an older plugin update', () => {
  const f = fixture(); const store = new PluginViewSessions(); const view = store.acquire('view', f.bridge, request);
  view.send({ type: 'input', nodeId: 'field', value: 'latest' }); assert.equal(view.getSnapshot().settled, false);
  const base = { kind: 'host-ui.update' as const, viewId: request.viewId, instanceId: f.opened[0].instanceId, css: '', mutations: [] };
  f.update({ ...base, sequence: 1, acknowledgedEvent: 0 }); assert.equal(view.getSnapshot().settled, false);
  f.update({ ...base, sequence: 2, acknowledgedEvent: 1 }); assert.equal(view.getSnapshot().settled, true); store.dispose();
});
test('idle instances are evicted while active instances are never silently replaced', () => {
  const f = fixture(); const store = new PluginViewSessions(1); const first = store.acquire('one', f.bridge, request);
  assert.throws(() => store.acquire('two', f.bridge, request), /Too many/); first.release();
  const second = store.acquire('two', f.bridge, request); assert.notEqual(second, first); assert.equal(f.closes.length, 1); store.dispose();
});
