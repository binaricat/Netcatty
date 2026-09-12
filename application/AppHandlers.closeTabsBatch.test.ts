import assert from 'node:assert/strict';
import test from 'node:test';
import { closeTabsBatchImpl } from './app/AppHandlers.ts';

function setup() {
  const closed: string[] = [];
  const probes: string[][] = [];
  const editors = [{ id: 'e', sessionId: 'connection', sftpTabId: 'pane' }];
  let active = 's1';
  const ctx = {
    closeLogView: (id: string) => { closed.push(id); },
    closeSessions: (ids: string[]) => { closed.push(...ids); },
    closeTabsInFlightRef: { current: false },
    closeWorkspace: (id: string) => { closed.push(id); },
    confirmIfBusyLocalTerminal: async (ids: string[]) => { probes.push(ids); return true; },
    logViews: [{ id: 'log' }],
    sessions: [{ id: 's1', workspaceId: null as string | null }, { id: 's2', workspaceId: null as string | null }],
    workspaces: [{ id: 'ws' }],
    activeTabStore: { getActiveTabId: () => active, setActiveTabId: (id: string) => { active = id; } },
    editorTabStore: { getTabs: () => editors },
    pluginViewTabStore: {
      getTab: (id: string) => id === 'plugin',
      close: (id: string) => { closed.push(id); },
    },
    handleRequestCloseEditorTabRef: { current: async (id: string) => {
      closed.push(`editor:${id}`);
      editors.splice(editors.findIndex((editor) => editor.id === id), 1);
      return true;
    } },
    findEditorSftpOwnerTabId: (_connection?: string, _pane?: string): string | null => null,
    orderedTabsWithEditors: ['s1', 's2', 'ws', 'editor:e', 'log', 'plugin'],
  };
  return { ctx, closed, probes, run: (ids: string[]) => closeTabsBatchImpl(() => ctx, ids) };
}

test('batch closes sessions, workspaces, editors, logs and plugins and selects surviving tab', async () => {
  const { ctx, closed, probes, run } = setup();
  assert.equal(await run(['s1', 'ws', 'editor:e', 'log', 'plugin']), true);
  assert.deepEqual(closed, ['editor:e', 's1', 'ws', 'log', 'plugin']);
  assert.deepEqual(probes, [['s1']]);
  assert.equal(ctx.activeTabStore.getActiveTabId(), 's2');
  assert.equal(ctx.closeTabsInFlightRef.current, false);
});

test('busy cancellation happens before any editor or other tab mutation', async () => {
  const { ctx, closed, run } = setup();
  ctx.confirmIfBusyLocalTerminal = async () => false;
  assert.equal(await run(ctx.orderedTabsWithEditors), false);
  assert.deepEqual(closed, []);
  assert.equal(ctx.activeTabStore.getActiveTabId(), 's1');
  assert.equal(ctx.closeTabsInFlightRef.current, false);
});

test('cancelled editor preserves its owner and active focus', async () => {
  const { ctx, closed, run } = setup();
  ctx.findEditorSftpOwnerTabId = () => 's1';
  ctx.handleRequestCloseEditorTabRef.current = async () => false;
  await run(ctx.orderedTabsWithEditors);
  assert.deepEqual(closed, ['s2', 'ws', 'log', 'plugin']);
  assert.equal(ctx.activeTabStore.getActiveTabId(), 's1');
});

test('editor outside close-left range preserves its owner', async () => {
  const { ctx, closed, run } = setup();
  ctx.findEditorSftpOwnerTabId = () => 's1';
  await run(['s1']);
  assert.deepEqual(closed, []);
});

test('preserved workspace containing an editor owner remains focused', async () => {
  const { ctx, closed, probes, run } = setup();
  ctx.sessions[0].workspaceId = 'ws';
  ctx.findEditorSftpOwnerTabId = () => 's1';
  ctx.activeTabStore.setActiveTabId('ws');
  await run(['ws']);
  assert.deepEqual(closed, []);
  assert.deepEqual(probes, [['s1']]);
  assert.equal(ctx.activeTabStore.getActiveTabId(), 'ws');
});

test('cancelled editor becomes focus destination when other tabs close', async () => {
  const { ctx, run } = setup();
  ctx.handleRequestCloseEditorTabRef.current = async () => false;
  await run(ctx.orderedTabsWithEditors);
  assert.equal(ctx.activeTabStore.getActiveTabId(), 'editor:e');
});

for (const phase of ['busy', 'editor'] as const) {
  test(`overlapping batch is ignored during ${phase} prompt, including editor-only batches`, async () => {
    const { ctx, closed, run } = setup();
    let release!: (result: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    if (phase === 'busy') ctx.confirmIfBusyLocalTerminal = () => pending;
    else ctx.handleRequestCloseEditorTabRef.current = () => pending;
    const first = run(phase === 'busy' ? ['s1'] : ['editor:e']);
    assert.equal(ctx.closeTabsInFlightRef.current, true);
    assert.equal(await run(['s2', 'plugin']), false);
    assert.deepEqual(closed, []);
    release(false);
    await first;
    assert.equal(ctx.closeTabsInFlightRef.current, false);
  });
}

test('failed prompt releases guard so next batch can run', async () => {
  const { ctx, run } = setup();
  ctx.handleRequestCloseEditorTabRef.current = async () => { throw new Error('save failed'); };
  await assert.rejects(run(['editor:e']), /save failed/);
  assert.equal(ctx.closeTabsInFlightRef.current, false);
  assert.equal(await run(['s1']), true);
});
