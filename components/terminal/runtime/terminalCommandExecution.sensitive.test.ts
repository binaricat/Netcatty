import assert from 'node:assert/strict';
import test from 'node:test';

import { recordTerminalCommandExecution } from './terminalCommandExecution.ts';

function createFakeTerm(lineText: string) {
  return {
    buffer: {
      active: {
        cursorX: lineText.length,
        cursorY: 0,
        baseY: 0,
        getLine(line: number) {
          if (line !== 0) return undefined;
          return {
            isWrapped: false,
            translateToString() { return lineText; },
          };
        },
      },
    },
  };
}

test('sensitive challenge input never reaches command history or semantic callbacks', () => {
  const submitted: string[] = [];
  const executed: string[] = [];
  const commandBufferRef = { current: '123456' };
  const result = recordTerminalCommandExecution('123456', {
    host: { id: 'host-1', label: 'Host' },
    sessionId: 'session-1',
    onCommandSubmitted: (command) => submitted.push(command),
    onCommandExecuted: (command) => executed.push(command),
    commandBufferRef,
  }, createFakeTerm('OTP> 123456') as never, { sensitive: false });

  assert.equal(result, null);
  assert.equal(commandBufferRef.current, '');
  assert.deepEqual(submitted, []);
  assert.deepEqual(executed, []);
});

test('unknown authentication and REPL prompts fail closed before plugin semantic callbacks', () => {
  for (const lineText of ['Custom authentication> hunter2', 'python> print(secret)']) {
    const submitted: string[] = [];
    const executed: string[] = [];
    const command = lineText.split(' ').at(-1) ?? '';
    const commandBufferRef = { current: command };
    const result = recordTerminalCommandExecution(command, {
      host: { id: 'host-1', label: 'Host' },
      sessionId: 'session-1',
      onTrustedCommandSubmitted: (command) => submitted.push(command),
      onCommandExecuted: (command) => executed.push(command),
      commandBufferRef,
    }, createFakeTerm(lineText) as never);
    assert.equal(result, command, lineText);
    assert.deepEqual(submitted, [], lineText);
    assert.deepEqual(executed, [command], lineText);
  }
});

test('semantic callbacks run only after a shell or explicitly identified device prompt is trusted', () => {
  for (const [lineText, command, allowDevice] of [
    ['alice@host:~$ echo ok', 'echo ok', false],
    ['router> show version', 'show version', true],
  ] as const) {
    const submitted: string[] = [];
    const executed: string[] = [];
    const commandBufferRef = { current: command };
    const result = recordTerminalCommandExecution(command, {
      host: { id: 'host-1', label: 'Host' },
      sessionId: 'session-1',
      onTrustedCommandSubmitted: (value) => submitted.push(value),
      onCommandExecuted: (value) => executed.push(value),
      commandBufferRef,
    }, createFakeTerm(lineText) as never, {
      allowHostStyleGreaterThanPrompt: allowDevice,
    });
    assert.equal(result, command, lineText);
    assert.deepEqual(submitted, [command], lineText);
    assert.deepEqual(executed, [command], lineText);
  }
});

test('plugin semantic callbacks fail closed when terminal prompt state is unavailable', () => {
  const submitted: string[] = [];
  const executed: string[] = [];
  const commandBufferRef = { current: 'echo ok' };
  const result = recordTerminalCommandExecution('echo ok', {
    host: { id: 'host-1', label: 'Host' },
    sessionId: 'session-1',
    onTrustedCommandSubmitted: (command) => submitted.push(command),
    onCommandExecuted: (command) => executed.push(command),
    commandBufferRef,
  });

  assert.equal(result, 'echo ok');
  assert.deepEqual(submitted, []);
  assert.deepEqual(executed, ['echo ok']);
});

test('acknowledged pasted commands enter history over output without becoming trusted semantic input', () => {
  for (const acknowledgedWrite of [false, true]) {
    const history: string[] = [];
    const trusted: string[] = [];
    recordTerminalCommandExecution('cd /tmp', {
      host: { id: 'h', label: 'h' }, sessionId: 's', commandBufferRef: { current: '' },
      onCommandExecuted: command => history.push(command),
      onTrustedCommandSubmitted: command => trusted.push(command),
    }, createFakeTerm('working... still producing output') as never, { useProvidedCommand: true, acknowledgedWrite });
    assert.deepEqual(history, acknowledgedWrite ? ['cd /tmp'] : []);
    assert.deepEqual(trusted, []);
  }
});

test('acknowledged writes retain both live challenge and explicit sensitive checks', () => {
  for (const [line, sensitive] of [['Password: ', false], ['OTP> ', false], ['output', true]] as const) {
    const history: string[] = [];
    const submitted: string[] = [];
    const result = recordTerminalCommandExecution('secret', {
      host: { id: 'h', label: 'h' }, sessionId: 's', commandBufferRef: { current: '' },
      onCommandExecuted: command => history.push(command),
      onCommandSubmitted: command => submitted.push(command),
    }, createFakeTerm(line) as never, { sensitive, useProvidedCommand: true, acknowledgedWrite: true });
    assert.equal(result, null);
    assert.deepEqual(history, []);
    assert.deepEqual(submitted, []);
  }
});
