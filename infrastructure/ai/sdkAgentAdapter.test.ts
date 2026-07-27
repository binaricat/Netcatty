import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSdkAgentErrorForDisplay, runSdkAgentTurn, steerSdkAgentTurn } from './sdkAgentAdapter';
import type { SdkAgentCallbacks } from './sdkAgentAdapter';
import type { ExternalAgentConfig } from './types';

function createCallbacks(errors: string[]): SdkAgentCallbacks {
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

const sdkConfig: ExternalAgentConfig = {
  id: 'agent',
  name: 'Agent',
  command: 'agent',
  enabled: true,
  sdkBackend: 'codex',
};

test('steerSdkAgentTurn forwards the active request and preserves typed outcomes', async () => {
  const calls: unknown[][] = [];
  const result = await steerSdkAgentTurn({
    aiSdkAgentSteer: async (...args: unknown[]) => {
      calls.push(args);
      return { status: 'not-steerable', turnKind: 'review' };
    },
  }, 'request-1', 'chat-1', 'change direction', [{
    base64Data: 'aGVsbG8=',
    mediaType: 'image/png',
    filename: 'image.png',
  }], 'user-1');

  assert.deepEqual(result, { status: 'not-steerable', turnKind: 'review' });
  assert.deepEqual(calls[0], [
    'request-1',
    'chat-1',
    'change direction',
    [{ base64Data: 'aGVsbG8=', mediaType: 'image/png', filename: 'image.png' }],
    'user-1',
  ]);
  assert.deepEqual(await steerSdkAgentTurn({}, 'request-1', 'chat-1', 'text', undefined, 'user-1'), {
    status: 'unsupported',
  });
});

test('formatSdkAgentErrorForDisplay preserves nested SDK agent error messages', () => {
  assert.equal(
    formatSdkAgentErrorForDisplay({
      error: {
        code: 'invalid_model',
        message: 'Model is not available',
      },
    }),
    'Model is not available',
  );
});

test('formatSdkAgentErrorForDisplay stringifies unknown objects instead of [object Object]', () => {
  assert.equal(
    formatSdkAgentErrorForDisplay({ status: 502, detail: 'Proxy failed' }),
    '{"status":502,"detail":"Proxy failed"}',
  );
});

test('formatSdkAgentErrorForDisplay handles circular errors', () => {
  const error: Record<string, unknown> = { status: 500 };
  error.self = error;

  assert.equal(
    formatSdkAgentErrorForDisplay(error),
    '{"status":500,"self":"[Circular]"}',
  );
});

test('runSdkAgentTurn formats structured startup errors', async () => {
  const errors: string[] = [];
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async () => ({
      ok: false,
      error: {
        error: {
          code: 'invalid_model',
          message: 'Model is not available',
        },
      },
    }),
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: () => () => {},
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-1',
    'chat-1',
    sdkConfig,
    'hello',
    createCallbacks(errors),
  );

  assert.deepEqual(errors, ['Model is not available']);
});

test('runSdkAgentTurn forwards configured SDK agent environment', async () => {
  let streamArgs: unknown[] = [];
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async (...args: unknown[]) => {
      streamArgs = args;
      queueMicrotask(() => done?.());
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-env',
    'chat-env',
    {
      ...sdkConfig,
      env: { CLAUDE_CODE_EXECUTABLE: '/opt/homebrew/bin/claude' },
    },
    'hello',
    createCallbacks([]),
  );

  assert.deepEqual(streamArgs[13], {
    CLAUDE_CODE_EXECUTABLE: '/opt/homebrew/bin/claude',
  });
  assert.equal(streamArgs[2], 'codex');
});

test('runSdkAgentTurn forwards the configured agent command path', async () => {
  let streamArgs: unknown[] = [];
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async (...args: unknown[]) => {
      streamArgs = args;
      queueMicrotask(() => done?.());
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-command',
    'chat-command',
    {
      ...sdkConfig,
      command: '/opt/homebrew/bin/codex',
      commandSource: 'manual',
    },
    'hello',
    createCallbacks([]),
  );

  assert.equal(streamArgs[14], '/opt/homebrew/bin/codex');
});

test('runSdkAgentTurn does not forward auto-detected command paths', async () => {
  let streamArgs: unknown[] = [];
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async (...args: unknown[]) => {
      streamArgs = args;
      queueMicrotask(() => done?.());
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-auto-command',
    'chat-auto-command',
    {
      ...sdkConfig,
      command: '/opt/homebrew/bin/codex',
      commandSource: 'auto',
    },
    'hello',
    createCallbacks([]),
  );

  assert.equal(streamArgs[14], undefined);
});

test('runSdkAgentTurn stores SDK session ids with backend and path metadata', async () => {
  const sessionIds: string[] = [];
  let onEvent: ((event: unknown) => void) | null = null;
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async () => {
      queueMicrotask(() => {
        onEvent?.({
          type: 'session-id',
          sessionId: 'thread-1',
          sdkBackend: 'codex',
          binPath: '/opt/homebrew/bin/codex',
        });
        done?.();
      });
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: (_requestId: unknown, cb: unknown) => {
      onEvent = cb as (event: unknown) => void;
      return () => {};
    },
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-session-metadata',
    'chat-session-metadata',
    sdkConfig,
    'hello',
    {
      ...createCallbacks([]),
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    },
  );

  assert.equal(sessionIds.length, 1);
  assert.match(sessionIds[0], /^netcatty-sdk-session:/);
  const payload = JSON.parse(decodeURIComponent(sessionIds[0].replace(/^netcatty-sdk-session:/, '')));
  assert.deepEqual(payload, {
    v: 1,
    id: 'thread-1',
    backend: 'codex',
    binPath: '/opt/homebrew/bin/codex',
    runtime: 'sdk',
  });
});

test('runSdkAgentTurn forwards Cursor API key as agent environment', async () => {
  let streamArgs: unknown[] = [];
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async (...args: unknown[]) => {
      streamArgs = args;
      queueMicrotask(() => done?.());
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-cursor-key',
    'chat-cursor-key',
    {
      id: 'cursor',
      name: 'Cursor',
      command: 'cursor',
      enabled: true,
      sdkBackend: 'cursor',
      apiKey: 'cur-test-key',
    },
    'hello',
    createCallbacks([]),
  );

  assert.deepEqual(streamArgs[13], {
    NETCATTY_CURSOR_AUTH_MODE: 'api-key',
    CURSOR_API_KEY: 'cur-test-key',
  });
  assert.equal(streamArgs[2], 'cursor');
});

test('runSdkAgentTurn forwards Antigravity API key through the shared SDK environment', async () => {
  let streamArgs: unknown[] = [];
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async (...args: unknown[]) => {
      streamArgs = args;
      queueMicrotask(() => done?.());
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-antigravity-key',
    'chat-antigravity-key',
    {
      id: 'antigravity',
      name: 'Google Antigravity',
      command: '/usr/bin/python3',
      enabled: true,
      sdkBackend: 'antigravity',
      apiKey: 'agy-test-key',
    },
    'hello',
    createCallbacks([]),
  );

  assert.deepEqual(streamArgs[13], { GEMINI_API_KEY: 'agy-test-key' });
  assert.equal(streamArgs[14], '/usr/bin/python3');
  assert.equal(streamArgs[2], 'antigravity');
});

test('runSdkAgentTurn in cursor cli-login mode does not inject CURSOR_API_KEY', async () => {
  let streamArgs: unknown[] = [];
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async (...args: unknown[]) => {
      streamArgs = args;
      queueMicrotask(() => done?.());
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-cursor-cli',
    'chat-cursor-cli',
    {
      id: 'cursor',
      name: 'Cursor',
      command: '/Users/me/.local/bin/agent',
      enabled: true,
      sdkBackend: 'cursor',
      cursorAuthMode: 'cli-login',
      apiKey: 'should-not-inject',
    },
    'hello',
    createCallbacks([]),
  );

  assert.deepEqual(streamArgs[13], {
    NETCATTY_CURSOR_AUTH_MODE: 'cli-login',
    NETCATTY_CURSOR_CLI_BIN: '/Users/me/.local/bin/agent',
  });
});


test('runSdkAgentTurn formats structured async error events', async () => {
  const errors: string[] = [];
  let onError: ((error: unknown) => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async () => {
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
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: () => () => {},
    onAiSdkAgentError: (_requestId: unknown, cb: unknown) => {
      onError = cb as (error: unknown) => void;
      return () => {};
    },
  };

  await runSdkAgentTurn(
    bridge,
    'request-2',
    'chat-1',
    sdkConfig,
    'hello',
    createCallbacks(errors),
  );

  assert.deepEqual(errors, ['Proxy failed']);
});

test('runSdkAgentTurn formats structured stream error events', async () => {
  const errors: string[] = [];
  let onEvent: ((event: unknown) => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async () => {
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
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: (_requestId: unknown, cb: unknown) => {
      onEvent = cb as (event: unknown) => void;
      return () => {};
    },
    onAiSdkAgentDone: () => () => {},
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-3',
    'chat-1',
    sdkConfig,
    'hello',
    createCallbacks(errors),
  );

  assert.deepEqual(errors, ['Stream failed']);
});

test('runSdkAgentTurn forwards Codex activities and usage without treating warnings as fatal', async () => {
  const activities: unknown[] = [];
  const usages: unknown[] = [];
  const errors: string[] = [];
  let onEvent: ((event: unknown) => void) | null = null;
  let done: (() => void) | null = null;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    aiSdkAgentStream: async () => {
      queueMicrotask(() => {
        onEvent?.({
          type: 'file-change',
          itemId: 'patch-1',
          status: 'completed',
          changes: [{ path: 'src/app.ts', kind: 'update' }],
        });
        onEvent?.({
          type: 'web-search',
          itemId: 'search-1',
          query: 'Codex SDK events',
          status: 'completed',
        });
        onEvent?.({
          type: 'plan-update',
          itemId: 'plan-1',
          items: [{ text: 'Map events', completed: true }],
          status: 'completed',
        });
        onEvent?.({ type: 'warning', itemId: 'warning-1', message: 'Search result unavailable' });
        onEvent?.({
          type: 'usage',
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 25,
          reasoningTokens: 10,
          totalTokens: 125,
        });
        done?.();
      });
      return { ok: true };
    },
    aiSdkAgentCancel: async () => ({ ok: true }),
    onAiSdkAgentEvent: (_requestId: unknown, cb: unknown) => {
      onEvent = cb as (event: unknown) => void;
      return () => {};
    },
    onAiSdkAgentDone: (_requestId: unknown, cb: unknown) => {
      done = cb as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
  };

  await runSdkAgentTurn(
    bridge,
    'request-events',
    'chat-events',
    sdkConfig,
    'hello',
    {
      ...createCallbacks(errors),
      onFileChange: (activity) => activities.push(activity),
      onWebSearch: (activity) => activities.push(activity),
      onPlanUpdate: (activity) => activities.push(activity),
      onWarning: (activity) => activities.push(activity),
      onUsage: (usage) => usages.push(usage),
    },
  );

  assert.deepEqual((activities as Array<{ type: string }>).map((activity) => activity.type), [
    'file_change',
    'web_search',
    'plan_update',
    'warning',
  ]);
  assert.deepEqual(usages, [{
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 25,
    reasoningTokens: 10,
    totalTokens: 125,
    estimated: false,
  }]);
  assert.deepEqual(errors, []);
});
