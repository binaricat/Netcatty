import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { normalizeLineEndings, wrapBracketedPaste } from '../../../lib/utils';
import { AUTO_RUN_SNIPPET_LINE_DELAY_MS, shouldDelayAutoRunSnippetInput } from '../terminalHelpers';

// Exercise the shared production sender without mounting an Electron terminal.
const source = readFileSync(new URL('../../Terminal.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const executeSnippetCommand = useCallback(');
const end = source.indexOf('  const executeSnippet = useCallback(', start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + '\nglobalThis.send = executeSnippetCommand;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type SendOptions = { preferBracketedPaste?: boolean; broadcast?: boolean; multiLineRunMode?: 'paste' | 'lineDelay' };
function setup(bracketedPasteMode = true, disableBracketedPaste = true) {
  const writes: Array<{ id: string; data: string; lineDelayMs?: number }> = [];
  const broadcasts: string[] = [];
  const context = {
    send: undefined as unknown as (command: string, noAutoRun?: boolean, options?: SendOptions) => Promise<boolean>,
    useCallback: (callback: unknown) => callback,
    termRef: { current: { modes: { bracketedPasteMode }, focus() {} } },
    sessionRef: { current: 'source' }, sessionId: 'source', hibernatedRef: { current: false },
    passwordPromptActiveRef: { current: false }, broadcastPasswordBypassRef: { current: false },
    isBroadcastEnabledRef: { current: false },
    shouldBroadcastDuringSensitivePrompt: () => true,
    isPromptSecurityAlternateScreenActive: () => false,
    onBroadcastInputRef: { current: (data: string) => { broadcasts.push(data); return ['peer']; } },
    normalizeLineEndings, wrapBracketedPaste, shouldDelayAutoRunSnippetInput, AUTO_RUN_SNIPPET_LINE_DELAY_MS,
    disableBracketedPasteRef: { current: disableBracketedPaste },
    prepareProgrammaticSudoInput: (data: string) => data,
    scrollToBottomAfterProgrammaticInput() {}, markTerminalBroadcastUserInput() {},
    terminalBackend: { writeToSession: (id: string, data: string, options: { lineDelayMs?: number }) => {
      writes.push({ id, data, lineDelayMs: options.lineDelayMs });
    } },
    host: { protocol: 'ssh' }, serialConfig: { lineMode: false },
  };
  runInNewContext(code, context);
  return { send: context.send, writes, broadcasts };
}

test('compose brackets multiline commands before the final Enter even when clipboard bracketing is disabled', async () => {
  const { send, writes, broadcasts } = setup();
  assert.equal(await send('echo one\r\necho two\necho three', false, {
    preferBracketedPaste: true, broadcast: true,
  }), true);
  assert.equal(writes[0].data, '\x1b[200~echo one\necho two\necho three\x1b[201~\r');
  assert.equal(writes[0].lineDelayMs, undefined);
  assert.deepEqual(broadcasts, [writes[0].data]);
});

test('single-line compose and snippet paste/line-delay preferences stay unchanged', async () => {
  const { send, writes } = setup();
  await send('echo one', false, { preferBracketedPaste: true });
  await send('echo one\necho two', false);
  await send('echo one\necho two', true);
  await send('echo one\necho two', false, { multiLineRunMode: 'lineDelay' });
  assert.deepEqual(writes.map(({ data, lineDelayMs }) => ({ data, lineDelayMs })), [
    { data: 'echo one\r', lineDelayMs: undefined },
    { data: 'echo one\necho two\r', lineDelayMs: undefined },
    { data: 'echo one\necho two', lineDelayMs: undefined },
    { data: 'echo one\necho two\r', lineDelayMs: 250 },
  ]);
  const unsupported = setup(false);
  await unsupported.send('echo one\necho two', false, { preferBracketedPaste: true });
  assert.equal(unsupported.writes[0].data.includes('\x1b[200~'), false);
  const enabled = setup(true, false);
  await enabled.send('echo one\necho two', false);
  assert.equal(enabled.writes[0].data, '\x1b[200~echo one\necho two\x1b[201~\r');
});

// Python's standard-library PTY lets Bash/Readline exercise the actual terminal
// bytes without depending on node-pty's Electron-specific native ABI.
const bashPty = String.raw`
import json, os, pty, select, signal, sys, time
payload = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe('bash', ['bash', '--noprofile', '--norc', '-i'],
               dict(os.environ, PS1='__COMPOSE_PROMPT__', TERM='xterm-256color',
                    INPUTRC='/dev/null', HISTFILE='/dev/null', PROMPT_COMMAND=''))
def prompt():
    output = b''
    deadline = time.monotonic() + 5
    while b'__COMPOSE_PROMPT__' not in output:
        if time.monotonic() > deadline:
            raise RuntimeError('Bash prompt timeout: ' + repr(output))
        if select.select([fd], [], [], 0.1)[0]:
            output += os.read(fd, 65536)
    # Multiple unbracketed commands produce a prompt between each line. Drain
    # their output too, so the echo control does not stop at the first prompt.
    while time.monotonic() < deadline and select.select([fd], [], [], 0.1)[0]:
        output += os.read(fd, 65536)
    return output
try:
    prompt()
    os.write(fd, b"stty -echo; bind 'set enable-bracketed-paste on'\r")
    prompt()
    os.write(fd, payload.encode())
    sys.stdout.write(prompt().decode(errors='replace'))
finally:
    os.kill(pid, signal.SIGKILL)
    os.close(fd)
    os.waitpid(pid, 0)
`;
const hasBashPty = process.platform !== 'win32'
  && spawnSync('python3', ['-c', 'import pty']).status === 0
  && spawnSync('bash', ['-c', '(( BASH_VERSINFO[0] >= 5 ))']).status === 0;

for (const [name, command, expected] of [
  ['all echo lines run', "echo '__ONE__'\necho '__TWO__'\necho '__THREE__'", ['__ONE__', '__TWO__', '__THREE__']],
  ['long first command cannot consume later commands as stdin',
    "sleep 0.4; read -r -t 0.4 consumed; printf '__STDIN__:%s\\n' \"$consumed\"\necho '__TWO__'\necho '__THREE__'",
    ['__STDIN__:', '__TWO__', '__THREE__']],
  ['single-line still runs', "echo '__ONE__'", ['__ONE__']],
] as const) {
  test(`Bash PTY compose: ${name}`, { skip: hasBashPty ? false : 'requires Python PTY support and Bash 5+' }, async () => {
    const { send, writes } = setup();
    await send(command, false, { preferBracketedPaste: true });
    const result = spawnSync('python3', ['-c', bashPty], {
      input: JSON.stringify(writes[0].data), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const lines = stripVTControlCharacters(result.stdout).split(/\r?\n/);
    assert.deepEqual(lines.filter(line => line.startsWith('__') && !line.startsWith('__COMPOSE_PROMPT__')), expected);
  });
}
