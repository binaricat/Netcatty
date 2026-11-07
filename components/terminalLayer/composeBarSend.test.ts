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
type Executor = (text: string, executeImmediately: boolean, options?: { broadcast?: boolean; sensitive?: boolean; preferBracketedPaste?: boolean }) => boolean | Promise<boolean>;
function setup(
  statuses: Status[],
  broadcast = false,
  executors = new Map<string, Executor>(),
  sensitive = new Set<string>(),
  broadcastPasswordBypass = false,
  restoredDisconnected = new Set<string>(),
  composeSendToAll?: boolean,
) {
  const writes: string[] = [];
  const context = {
    send: undefined as unknown as (text: string) => Promise<boolean>,
    useCallback: (callback: unknown) => callback,
    activeWorkspaceRef: { current: { id: 'workspace', focusedSessionId: '0' } },
    sessionsRef: { current: statuses.map((status, index) => ({
      id: String(index), workspaceId: 'workspace', status,
      restoreState: restoredDisconnected.has(String(index)) ? 'restored-disconnected' : undefined,
    })) },
    isBroadcastEnabled: () => broadcast,
    isComposeSendToAll: composeSendToAll === undefined ? undefined : () => composeSendToAll,
    isTerminalSensitiveInputActive: (id: string) => sensitive.has(id),
    broadcastPasswordBypassRef: { current: broadcastPasswordBypass },
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

test('compose active-only sends to the focused session while toolbar broadcast stays on', async () => {
  const { send, writes } = setup(
    ['connected', 'connected'], true, new Map(), new Set(), false, new Set(), false,
  );
  assert.equal(await send('command'), true);
  assert.deepEqual(writes, ['0']);
});

test('compose active-only does not run peer executors while toolbar broadcast stays on', async () => {
  const calls: Array<{ id: string; broadcast: boolean | undefined }> = [];
  const executors = new Map<string, Executor>([
    ['0', async (_text, _immediate, options) => {
      calls.push({ id: '0', broadcast: options?.broadcast });
      return true;
    }],
    ['1', async () => { calls.push({ id: '1', broadcast: undefined }); return true; }],
  ]);
  assert.equal(
    await setup(
      ['connected', 'connected'], true, executors, new Set(), false, new Set(), false,
    ).send('command'),
    true,
  );
  assert.deepEqual(calls, [{ id: '0', broadcast: false }]);
});

test('compose send-to-all fans out while toolbar broadcast stays off', async () => {
  const { send, writes } = setup(
    ['connected', 'connected'], false, new Map(), new Set(), false, new Set(), true,
  );
  assert.equal(await send('command'), true);
  assert.deepEqual(writes, ['0', '1']);
});

for (const sendToAll of [false, true]) {
  test(`workspace compose requests supported bracketed paste on each target (all=${sendToAll})`, async () => {
    const calls: string[] = [];
    const text = 'echo one\necho two\necho three';
    const executors = new Map<string, Executor>(['0', '1'].map(id => [id, async (command, noAutoRun, options) => {
      assert.equal(command, text);
      assert.equal(noAutoRun, false);
      assert.equal(options?.preferBracketedPaste, true);
      assert.equal(options?.broadcast, false);
      calls.push(id);
      return true;
    }]));
    const { send } = setup(['connected', 'connected'], false, executors, new Set(), false, new Set(), sendToAll);
    assert.equal(await send(text), true);
    assert.deepEqual(calls, sendToAll ? ['0', '1'] : ['0']);
  });
}

test('compose send-to-all keeps a bypassed sensitive peer out of history', async () => {
  const executors = new Map<string, Executor>([
    ['0', async () => true],
    ['1', async () => true],
  ]);
  assert.equal(
    await setup(
      ['connected', 'connected'], false, executors, new Set(['1']), true, new Set(), true,
    ).send('secret'),
    false,
  );
});

test('a disconnected broadcast peer cannot undo another successful fallback', async () => {
  assert.equal(await setup(['connected', 'disconnected'], true).send('command'), true);
});

test('the password bypass delivers sensitive sends but keeps them out of compose history (#3488)', async () => {
  let executorCalls = 0;
  const executors = new Map<string, Executor>([['0', async () => {
    executorCalls += 1;
    return true;
  }]]);
  // The payload was delivered (the executor ran), but the send originates from
  // a sensitive prompt, so the compose bar must not record it for ArrowUp.
  assert.equal(
    await setup(['connected'], true, executors, new Set(['0']), true).send('secret'),
    false,
  );
  assert.equal(executorCalls, 1);
});

test('bypassed fan-out into a lagging sensitive peer keeps the whole send out of history', async () => {
  // Focused session 0 is non-sensitive; lagging peer 1 sits at a password
  // prompt. The bypass delivers the payload there, but that text is peer 1's
  // password input, so the send must not be recallable via ArrowUp.
  for (const executorOwner of ['0', '1'] as const) {
    const executors = new Map<string, Executor>([[executorOwner, async () => true]]);
    assert.equal(
      await setup(['connected', 'connected'], true, executors, new Set(['1']), true).send('secret'),
      false,
    );
  }
});

test('bypassed fan-out preserves a sensitive peer snapshot across executor wake', async () => {
  const sensitive = new Set(['1']);
  let sensitiveAtWrite: boolean | undefined;
  const executors = new Map<string, Executor>([['1', async (_text, _executeImmediately, options) => {
    await Promise.resolve();
    sensitive.delete('1');
    sensitiveAtWrite = options?.sensitive;
    return true;
  }]]);
  assert.equal(await setup(['connected', 'connected'], true, executors, sensitive, true).send('secret'), false);
  assert.equal(sensitiveAtWrite, true);
});

test('a bypassed sensitive peer that rejects delivery does not hide another successful send', async () => {
  const executors = new Map<string, Executor>([
    ['0', async () => true],
    ['1', async () => false],
  ]);
  assert.equal(await setup(['connected', 'connected'], true, executors, new Set(['1']), true).send('command'), true);
});

test('a bypassed sensitive peer with no write route does not hide another successful send', async () => {
  const { send, writes } = setup(
    ['connected', 'disconnected'], true, new Map(), new Set(['1']), true, new Set(['1']),
  );
  assert.equal(await send('command'), true);
  assert.deepEqual(writes, ['0']);
});

test('a connecting sensitive fallback keeps attempted input out of history', async () => {
  assert.equal(await setup(['connected', 'connecting'], true, new Map(), new Set(['1']), true).send('secret'), false);
});

test('without the password bypass sensitive input is excluded for executor and fallback paths', async () => {
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
      composeSendToAll: undefined as boolean | undefined,
      isBroadcastEnabled: false,
    };
    runInNewContext(soloCode, context);
    assert.equal(await context.send('command'), await result);
  });
}

test('solo compose send uses the compose-bar target while toolbar broadcast stays on', async () => {
  const calls: Array<boolean | undefined> = [];
  const context = {
    send: undefined as unknown as (text: string) => Promise<boolean>,
    sessionId: 'a', sessionRef: { current: 'a' },
    executeSnippetCommand: (_text: string, _noAutoRun?: boolean, options?: { broadcast?: boolean; preferBracketedPaste?: boolean }) => {
      assert.equal(options?.preferBracketedPaste, true);
      calls.push(options?.broadcast);
      return true;
    },
    isTerminalSensitiveInputActive: () => false,
    composeSendToAll: false,
    isBroadcastEnabled: true,
  };
  runInNewContext(soloCode, context);
  assert.equal(await context.send('command'), true);
  context.composeSendToAll = true;
  context.isBroadcastEnabled = false;
  assert.equal(await context.send('command'), true);
  assert.deepEqual(calls, [false, true]);
});

test('solo missing sessions and sensitive input are excluded; rejection propagates to the compose handler', async () => {
  const context = {
    send: undefined as unknown as (text: string) => Promise<boolean>,
    sessionId: 'a', sessionRef: { current: null as string | null },
    executeSnippetCommand: async () => true,
    isTerminalSensitiveInputActive: () => false,
    composeSendToAll: undefined as boolean | undefined,
    isBroadcastEnabled: false,
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
