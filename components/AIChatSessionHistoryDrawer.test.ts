import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, ChatMessage } from '../infrastructure/ai/types.ts';
import { filterAIChatSessions } from './AIChatSessionHistoryDrawer.tsx';

function createMessage(content: string, id = content): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: 1,
  };
}

function createSession(
  id: string,
  title: string,
  messages: ChatMessage[] = [],
): AISession {
  return {
    id,
    title,
    agentId: 'catty',
    scope: { type: 'global' },
    messages,
    createdAt: 1,
    updatedAt: 1,
  };
}

const sessions = [
  createSession('title-match', 'Deploy production'),
  createSession('message-match', 'Release notes', [createMessage('Check the staging logs')]),
  createSession('pinyin-match', '数据库维护'),
];

test('session history search matches titles and message content', () => {
  assert.deepEqual(
    filterAIChatSessions(sessions, 'production').map((session) => session.id),
    ['title-match'],
  );
  assert.deepEqual(
    filterAIChatSessions(sessions, 'staging logs').map((session) => session.id),
    ['message-match'],
  );
});

test('session history search keeps shared matcher normalization and pinyin support', () => {
  assert.deepEqual(
    filterAIChatSessions(sessions, 'deploy-production').map((session) => session.id),
    ['title-match'],
  );
  assert.deepEqual(
    filterAIChatSessions(sessions, 'sjk').map((session) => session.id),
    ['pinyin-match'],
  );
});

test('blank session history search preserves the original session list', () => {
  assert.equal(filterAIChatSessions(sessions, '   '), sessions);
});

test('session history search requires every query token to match', () => {
  assert.deepEqual(filterAIChatSessions(sessions, 'production staging'), []);
});
