import assert from 'node:assert/strict';
import test from 'node:test';
import { getScopedHistorySessions } from '../../../components/ai/scopedHistorySessions';
import { applyHistorySessionSelection } from '../../../components/ai/aiPanelViewState';
import { resolveAgentHostOpenWorkspace } from '../../../domain/agentHostWorkspace';
import type { AISession, AISessionScope } from '../types';
import { AgentRuntime } from './agentRuntime';
import type { TurnDriver, TurnInput, TurnUiCallbacks } from './turnDrivers/types';

const ui: TurnUiCallbacks = {
  addMessageToSession: () => {}, updateLastMessage: () => {},
  updateMessageById: () => {}, reportStreamError: () => {},
  setStreamingForScope: () => {},
};

function turnInput(backend: TurnInput['backend'], scope: AISessionScope): TurnInput {
  const common = {
    chatSessionId: 'history-chat', assistantMsgId: 'assistant', userText: 'open a host',
    signal: new AbortController().signal, ui,
  };
  if (backend === 'external-sdk') return {
    ...common, backend, attachedImages: [],
    agentConfig: { id: 'test', name: 'Test', command: 'test', enabled: true },
    context: {
      scopeType: scope.type, scopeTargetId: scope.targetId,
      terminalSessions: [], providers: [], toolIntegrationMode: 'mcp', permissionMode: 'auto',
    },
  };
  return {
    ...common, backend, sendScopeKey: `${scope.type}:${scope.targetId ?? ''}`,
    currentSession: undefined, maxIterations: 1,
    context: {
      scopeType: scope.type, scopeTargetId: scope.targetId,
      activeProvider: undefined, activeModelId: '', terminalSessions: [],
      globalPermissionMode: 'auto', autoTitleSession: () => {},
    },
  };
}

for (const backend of ['catty', 'external-sdk'] as const) {
  test(`${backend}: resumed history opens hosts in the invoking scope throughout the turn`, async () => {
    const chat: AISession = {
      id: 'history-chat', title: 'History', agentId: 'catty', messages: [],
      scope: { type: 'workspace', targetId: 'ws-a' }, createdAt: 1, updatedAt: 1,
    };
    assert.ok(getScopedHistorySessions([chat], 'workspace', 'ws-b', [], new Set()).includes(chat));
    let selected: string | null = null;
    applyHistorySessionSelection(chat.id, {
      showSessionView: () => {}, setActiveSessionId: id => { selected = id; }, closeHistory: () => {},
    });
    assert.equal(selected, chat.id);
    assert.equal(chat.scope.targetId, 'ws-a');

    const placementContext = {
      activeTabId: 'ws-c', workspaceIds: ['ws-a', 'ws-b', 'ws-c'],
      terminalSessions: [{ id: 'term-b', workspaceId: 'ws-b' }],
    };
    let expected: string | undefined;
    const driver: TurnDriver = {
      backend,
      async run(input) {
        // A later focus/context change must not redirect this running turn.
        input.context.scopeTargetId = 'ws-c';
        const scope = runtime.getActiveScope(chat.id);
        const invokingChat = scope ? { scope } : chat;
        assert.deepEqual(resolveAgentHostOpenWorkspace(undefined, invokingChat, placementContext),
          expected ? { workspaceId: expected } : {});
        assert.deepEqual(resolveAgentHostOpenWorkspace('current', invokingChat, placementContext),
          { workspaceId: expected ?? 'ws-c' });
        assert.deepEqual(resolveAgentHostOpenWorkspace('ws-a', invokingChat, placementContext),
          { workspaceId: 'ws-a' });
      },
    };
    const runtime = new AgentRuntime({ drivers: [driver] });
    for (const scope of [
      { type: 'workspace', targetId: 'ws-b' },
      { type: 'terminal', targetId: 'term-b' },
      { type: 'global' },
    ] satisfies AISessionScope[]) {
      expected = scope.type === 'global' ? undefined : 'ws-b';
      await runtime.runTurn(turnInput(backend, scope));
      assert.equal(runtime.getActiveScope(chat.id), undefined);
    }
    // Completing a turn must not silently rewrite the saved history binding.
    assert.deepEqual(resolveAgentHostOpenWorkspace(undefined, chat, placementContext), { workspaceId: 'ws-a' });
  });

  test(`${backend}: failed turns release their captured host-open scope`, async () => {
    const runtime = new AgentRuntime({ drivers: [{
      backend, async run() { throw new Error('test failure'); },
    }] });
    await assert.rejects(runtime.runTurn(turnInput(backend, { type: 'workspace', targetId: 'ws-b' })), /test failure/);
    assert.equal(runtime.getActiveScope('history-chat'), undefined);
  });
}
