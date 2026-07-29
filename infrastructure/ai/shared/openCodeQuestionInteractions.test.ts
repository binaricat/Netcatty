import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  onOpenCodeQuestionInteraction,
  replayPendingOpenCodeQuestionInteractions,
  respondOpenCodeQuestion,
  setupOpenCodeQuestionInteractionBridge,
  type OpenCodeQuestionInteraction,
} from './openCodeQuestionInteractions';

describe('openCodeQuestionInteractions', () => {
  let requestListener: ((payload: OpenCodeQuestionInteraction) => void) | undefined;
  let clearedListener: ((payload: { interactionIds: string[] }) => void) | undefined;
  let lastResponse: Record<string, unknown> | undefined;
  let teardown = () => {};

  afterEach(() => {
    teardown();
    teardown = () => {};
    requestListener = undefined;
    clearedListener = undefined;
    lastResponse = undefined;
    delete (globalThis as { window?: unknown }).window;
  });

  it('replays pending questions and forwards replies to the preload bridge', async () => {
    (globalThis as { window: unknown }).window = {
      netcatty: {
        onOpenCodeQuestionRequest: (listener: typeof requestListener) => {
          requestListener = listener;
          return () => { requestListener = undefined; };
        },
        onOpenCodeQuestionCleared: (listener: typeof clearedListener) => {
          clearedListener = listener;
          return () => { clearedListener = undefined; };
        },
        respondOpenCodeQuestion: async (payload: Record<string, unknown>) => {
          lastResponse = payload;
          return { ok: true };
        },
      },
    };

    teardown = setupOpenCodeQuestionInteractionBridge();
    const received: OpenCodeQuestionInteraction[] = [];
    const unsubscribe = onOpenCodeQuestionInteraction((interaction) => received.push(interaction));

    requestListener?.({
      interactionId: 'opencode_question_req-1',
      source: 'opencode',
      kind: 'user-input',
      requestId: 'req-1',
      chatSessionId: 'chat-1',
      questions: [{
        id: 'q0',
        header: 'Mode',
        question: 'Choose',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Safe', description: 'Read only' }],
      }],
    });

    assert.equal(received.length, 1);
    const replayed: OpenCodeQuestionInteraction[] = [];
    replayPendingOpenCodeQuestionInteractions((interaction) => replayed.push(interaction));
    assert.equal(replayed.length, 1);

    await respondOpenCodeQuestion('opencode_question_req-1', {
      q0: { answers: ['Safe'] },
    });
    assert.deepEqual(lastResponse, {
      interactionId: 'opencode_question_req-1',
      answers: { q0: { answers: ['Safe'] } },
      reject: false,
    });

    clearedListener?.({ interactionIds: ['opencode_question_req-1'] });
    unsubscribe();
  });

  it('treats empty answers as a reject', async () => {
    (globalThis as { window: unknown }).window = {
      netcatty: {
        onOpenCodeQuestionRequest: () => () => {},
        respondOpenCodeQuestion: async (payload: Record<string, unknown>) => {
          lastResponse = payload;
          return { ok: true };
        },
      },
    };
    teardown = setupOpenCodeQuestionInteractionBridge();
    await respondOpenCodeQuestion('opencode_question_req-2', {});
    assert.deepEqual(lastResponse, {
      interactionId: 'opencode_question_req-2',
      answers: undefined,
      reject: true,
    });
  });
});
