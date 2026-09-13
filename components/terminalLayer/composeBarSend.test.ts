import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { canUseDirectSessionWriteFallback } from './terminalLayerSessionRouting';

// Exercise the actual workspace send callback without constructing terminals.
const source = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleComposeSend =');
const end = source.indexOf('  const sessionLogConfig =', start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + '\nglobalThis.send = handleComposeSend;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Status = 'connected' | 'connecting' | 'disconnected';
type Executor = () => boolean | Promise<boolean>;
function setup(statuses: Status[], broadcast = false, executors = new Map<string, Executor>(), sensitive = new Set<string>()) {
  const writes: string[] = [];
  const context = {
    send: undefined as unknown as (text: string) => Promise<boolean>,
    useCallback: (callback: unknown) => callback,
    activeWorkspaceRef: { current: { id: 'workspace', focusedSessionId: '0' } },
    sessionsRef: { current: statuses.map((status, index) => ({ id: String(index), workspaceId: 'workspace', status })) },
    isBroadcastEnabled: () => broadcast,
    isTerminalSensitiveInputActive: (id: string) => sensitive.has(id),
    snippetExecutorsRef: { current: executors },
    canUseDirectSessionWriteFallback,
    terminalBackend: { writeToSession: (id: string) => writes.push(id) },
  };
  runInNewContext(code, context);
  return { send: context.send, writes };
}

for (const broadcast of [false, true]) {
  for (const status of ['connected', 'connecting', 'disconnected'] as const) {
    test(`fallback history requires a connected session (${status}, broadcast=${broadcast})`, async () => {
      const { send, writes } = setup([status], broadcast);
      assert.equal(await send('command'), status === 'connected');
      assert.deepEqual(writes, ['0']); // Existing fallback dispatch is unchanged.
    });
  }
  for (const accepted of [false, true]) {
    test(`executor result controls history (${accepted}, broadcast=${broadcast})`, async () => {
      const { send } = setup(['connected'], broadcast, new Map([['0', async () => accepted]]));
      assert.equal(await send('command'), accepted);
    });
  }
}

test('a disconnected broadcast peer cannot undo another successful fallback', async () => {
  assert.equal(await setup(['connected', 'disconnected'], true).send('command'), true);
});

test('sensitive input is excluded for executor and fallback paths', async () => {
  for (const broadcast of [false, true]) {
    for (const executors of [new Map<string, Executor>(), new Map<string, Executor>([['0', async () => true]])]) {
      assert.equal(await setup(['connected'], broadcast, executors, new Set(['0'])).send('secret'), false);
    }
  }
});

test('broadcast still records a successful send when another executor rejects', async () => {
  const executors = new Map<string, Executor>([
    ['0', async () => true],
    ['1', async () => { throw new Error('failed'); }],
  ]);
  assert.equal(await setup(['connected', 'connected'], true, executors).send('command'), true);
});

test('all failed workspace executors do not record history', async () => {
  for (const broadcast of [false, true]) {
    const executors = new Map<string, Executor>([['0', async () => { throw new Error('failed'); }]]);
    assert.equal(await setup(['connected'], broadcast, executors).send('command'), false);
  }
});

test('executor waking into a sensitive prompt does not record history', async () => {
  const sensitive = new Set<string>();
  const executors = new Map<string, Executor>([['0', async () => { sensitive.add('0'); return true; }]]);
  assert.equal(await setup(['connected'], false, executors, sensitive).send('command'), false);
});

const soloSource = readFileSync(new URL('../terminal/TerminalView.tsx', import.meta.url), 'utf8');
const soloStart = soloSource.indexOf('onSend={async (text) => {');
const soloEnd = soloSource.indexOf('\n            }}', soloStart);
assert.ok(soloStart >= 0 && soloEnd > soloStart);
const soloCode = ts.transpileModule('globalThis.send = ' + soloSource.slice(
  soloStart + 'onSend={'.length, soloEnd + '\n            }'.length,
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

for (const result of [true, false, Promise.resolve(true), Promise.resolve(false)]) {
  test(`solo send uses executor acknowledgement (${typeof result})`, async () => {
    const context = {
      send: undefined as unknown as (text: string) => Promise<boolean>,
      sessionId: 'a', sessionRef: { current: 'a' },
      executeSnippetCommand: () => result,
      isTerminalSensitiveInputActive: () => false,
    };
    runInNewContext(soloCode, context);
    assert.equal(await context.send('command'), await result);
  });
}

test('solo missing sessions and sensitive input are excluded; rejection propagates to the compose handler', async () => {
  const context = {
    send: undefined as unknown as (text: string) => Promise<boolean>,
    sessionId: 'a', sessionRef: { current: null as string | null },
    executeSnippetCommand: async () => true,
    isTerminalSensitiveInputActive: () => false,
  };
  runInNewContext(soloCode, context);
  assert.equal(await context.send('command'), false);
  context.sessionRef.current = 'a';
  context.isTerminalSensitiveInputActive = () => true;
  assert.equal(await context.send('secret'), false);
  context.isTerminalSensitiveInputActive = () => false;
  context.executeSnippetCommand = async () => { throw new Error('failed'); };
  await assert.rejects(context.send('command'), /failed/);
});
