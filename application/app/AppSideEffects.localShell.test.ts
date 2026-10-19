import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createLocalShellHost, resolveHostDefaultLocalShell } from '../../domain/localShellHost';
import { createHostTerminalSession } from '../state/sessionFactories';

// Exercise the production application callback, including its async command
// resolution boundary, before the state hook snapshots the shell type.
const source = readFileSync(new URL('./AppSideEffects.tsx', import.meta.url), 'utf8');
const callback = source.match(/const handleRunSnippet = useCallback\(([\s\S]*?)\n {2}\);/)?.[1];
assert.ok(callback);
const compiled = ts.transpile(`const run = useCallback(${callback});`, { target: ts.ScriptTarget.ES2022 });

for (const script of [false, true]) {
  test(`saved default local shell is resolved before ${script ? 'script' : 'snippet'} sessions are created`, async () => {
    let session: ReturnType<typeof createHostTerminalSession> | undefined;
    const run = new Function('useCallback', 'isScriptSnippet', 'runSnippet', 'resolveSnippetCommand', 'resolveEffectiveHost', `${compiled} return run;`)(
      (value: unknown) => value,
      () => script,
      (_snippet: unknown, hosts: ReturnType<typeof createLocalShellHost>[]) => {
        session = createHostTerminalSession('snippet-local', hosts[0]);
      },
      async () => 'echo hello',
      (host: ReturnType<typeof createLocalShellHost>) => resolveHostDefaultLocalShell(host, {
        terminalSettings: { localShell: 'cmd' },
        resolveShellSetting: () => ({ command: 'cmd.exe' }),
      }),
    );
    await run({ id: 'snippet-1' }, [createLocalShellHost({ os: 'windows' })]);
    assert.equal(session?.protocol, 'local');
    assert.equal(session?.localShell, 'cmd.exe');
    assert.equal(session?.shellType, 'cmd');
  });
}
