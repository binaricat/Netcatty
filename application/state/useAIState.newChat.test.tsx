import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { resolveInheritedAIActiveSessionId } from '../../domain/aiWorkspaceScopeInherit.ts';
import { resolveDisplayedPanelView } from '../../components/ai/aiPanelViewState.ts';
import type { AISession } from '../../infrastructure/ai/types.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';
import { useAIState } from './useAIState.ts';

const SCOPE_KEY = 'workspace:workspace-old';
const RESTORED_SESSION: AISession = {
  id: 'chat-old',
  title: 'Restored chat',
  agentId: 'catty',
  scope: {
    type: 'terminal',
    targetId: 'terminal-a',
    hostIds: ['host-a'],
  },
  messages: [
    { id: 'user-1', role: 'user', content: 'old question', timestamp: 1 },
    { id: 'assistant-1', role: 'assistant', content: 'old answer', timestamp: 2 },
  ],
  createdAt: 1,
  updatedAt: 2,
};

function NewChatHarness() {
  const ai = useAIState();
  const state = useAISessionsStore();
  const visibleSessionIds = new Set(state.sessions.map((session) => session.id));
  const inheritedSessionId = resolveInheritedAIActiveSessionId({
    scopeType: 'workspace',
    scopeTargetId: 'workspace-old',
    activeSessionIdMap: state.activeSessionIdMap,
    memberTerminalIds: ['terminal-a', 'terminal-b'],
    preferredTerminalId: 'terminal-a',
    visibleSessionIds,
  });
  const view = resolveDisplayedPanelView(
    state.panelViewByScope[SCOPE_KEY],
    state.draftsByScope[SCOPE_KEY] != null,
    state.sessions as AISession[],
    inheritedSessionId,
    'workspace',
  );

  return (
    <button
      type="button"
      data-view={view.mode}
      data-session={view.mode === 'session' ? view.sessionId : ''}
      onClick={() => {
        ai.clearDraftForScope(SCOPE_KEY);
        ai.updateDraft(SCOPE_KEY, 'catty', () => ({
          text: '',
          agentId: 'catty',
          attachments: [],
          selectedUserSkillSlugs: [],
          updatedAt: Date.now(),
        }));
        ai.showDraftView(SCOPE_KEY);
      }}
    >
      New Chat
    </button>
  );
}

test('restored workspace enters a blank draft when New Chat is clicked', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: dom.window.localStorage,
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: dom.window.CustomEvent,
  });
  Object.defineProperty(globalThis, 'Event', {
    configurable: true,
    value: dom.window.Event,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });

  dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify([RESTORED_SESSION]));
  dom.window.localStorage.setItem('netcatty_ai_active_session_map_v1', JSON.stringify({
    'terminal:terminal-a': RESTORED_SESSION.id,
    [SCOPE_KEY]: RESTORED_SESSION.id,
  }));

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<NewChatHarness />);
  });

  const button = container.querySelector('button');
  assert.ok(button);
  assert.equal(button.dataset.view, 'session');
  assert.equal(button.dataset.session, RESTORED_SESSION.id);

  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  assert.equal(button.dataset.view, 'draft');
  assert.equal(button.dataset.session, '');

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});
