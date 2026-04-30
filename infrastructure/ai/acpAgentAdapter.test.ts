import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAcpErrorForDisplay, runAcpAgentTurn } from './acpAgentAdapter';
import type { AcpAgentCallbacks } from './acpAgentAdapter';
import type { ExternalAgentConfig } from './types';

function createCallbacks(errors: string[]): AcpAgentCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onThinkingDone: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: (error) => errors.push(error),
    onDone: () => {},
  };
}

const acpConfig: ExternalAgentConfig = {
  id: 'agent',
  name: 'Agent',
  command: 'agent',
  enabled: true,
  acpCommand: 'agent-acp',
  acpArgs: [],
};

test('formatAcpErrorForDisplay preserves nested ACP error messages', () => {
  assert.equal(
    formatAcpErrorForDisplay({
      error: {
        code: 'invalid_model',
        message: 'Model is not available',
      },
    }),
    'Model is not available',
  );
});

test('formatAcpErrorForDisplay stringifies unknown objects instead of [object Object]', () => {
  assert.equal(
    formatAcpErrorForDisplay({ status: 502, detail: 'Proxy failed' }),
    '{"status":502,"detail":"Proxy failed"}',
  );
});

test('formatAcpErrorForDisplay handles circular errors', () => {
  const error: Record<string, unknown> = { status: 500 };
  error.self = error;

  assert.equal(
    formatAcpErrorForDisplay(error),
    '{"status":500,"self":"[Circular]"}',
  );
});

test('runAcpAgentTurn formats structured startup errors', async () => {
  const errors: string[] = [];
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiAcpStream: async () => ({
      ok: false,
      error: {
        error: {
          code: 'invalid_model',
          message: 'Model is not available',
        },
      },
    }),
    aiAcpCancel: async () => ({ ok: true }),
    onAiAcpEvent: () => () => {},
    onAiAcpDone: () => () => {},
    onAiAcpError: () => () => {},
  };

  await runAcpAgentTurn(
    bridge,
    'request-1',
    'chat-1',
    acpConfig,
    'hello',
    createCallbacks(errors),
  );

  assert.deepEqual(errors, ['Model is not available']);
});

test('runAcpAgentTurn formats structured async error events', async () => {
  const errors: string[] = [];
  let onError: ((error: unknown) => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiAcpStream: async () => {
      queueMicrotask(() => {
        onError?.({
          data: {
            error: {
              message: 'Proxy failed',
            },
          },
        });
      });
      return { ok: true };
    },
    aiAcpCancel: async () => ({ ok: true }),
    onAiAcpEvent: () => () => {},
    onAiAcpDone: () => () => {},
    onAiAcpError: (_requestId: unknown, cb: unknown) => {
      onError = cb as (error: unknown) => void;
      return () => {};
    },
  };

  await runAcpAgentTurn(
    bridge,
    'request-2',
    'chat-1',
    acpConfig,
    'hello',
    createCallbacks(errors),
  );

  assert.deepEqual(errors, ['Proxy failed']);
});

test('runAcpAgentTurn formats structured stream error events', async () => {
  const errors: string[] = [];
  let onEvent: ((event: unknown) => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiAcpStream: async () => {
      queueMicrotask(() => {
        onEvent?.({
          type: 'error',
          error: {
            error: {
              message: 'Stream failed',
            },
          },
        });
      });
      return { ok: true };
    },
    aiAcpCancel: async () => ({ ok: true }),
    onAiAcpEvent: (_requestId: unknown, cb: unknown) => {
      onEvent = cb as (event: unknown) => void;
      return () => {};
    },
    onAiAcpDone: () => () => {},
    onAiAcpError: () => () => {},
  };

  await runAcpAgentTurn(
    bridge,
    'request-3',
    'chat-1',
    acpConfig,
    'hello',
    createCallbacks(errors),
  );

  assert.deepEqual(errors, ['Stream failed']);
});
