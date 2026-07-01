import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldEmitAgentEventsForStreamChunk } from './turnDrivers/cattyStreamProcessor';

describe('shouldEmitAgentEventsForStreamChunk', () => {
  it('suppresses trace events for SDK internal stream-state errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('reasoning part abc not found'),
      }),
      false,
    );
  });

  it('still emits trace events for real stream errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('Provider returned HTTP 500'),
      }),
      true,
    );
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({ type: 'text-delta', text: 'hi' }),
      true,
    );
  });
});
