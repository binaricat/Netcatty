import assert from 'node:assert/strict';
import test from 'node:test';

import type { AIDraft, AISession } from '../infrastructure/ai/types';
import {
  aiChatSidePanelPropsAreEqual,
  hasAIChatSidePanelRetainedContent,
  shouldKeepAIChatSidePanelMounted,
} from './AIChatSidePanel.tsx';
import type { AIChatSidePanelProps } from './AIChatSidePanel.types.ts';

const draft = (overrides: Partial<AIDraft> = {}): AIDraft => ({
  text: '',
  agentId: 'catty',
  attachments: [],
  selectedUserSkillSlugs: [],
  updatedAt: 1,
  ...overrides,
});

const session = (overrides: Partial<AISession> = {}): AISession => ({
  id: 'session-1',
  title: 'Session',
  agentId: 'catty',
  scope: { type: 'terminal', targetId: 'terminal-1' },
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const baseProps = (overrides: Partial<AIChatSidePanelProps> = {}): AIChatSidePanelProps => ({
  sessions: [],
  activeSessionIdMap: {},
  draftsByScope: {},
  panelViewByScope: {},
  setActiveSessionId: () => undefined,
  ensureDraftForScope: () => undefined,
  updateDraft: () => undefined,
  showDraftView: () => undefined,
  showSessionView: () => undefined,
  clearDraftForScope: () => undefined,
  addDraftFiles: async () => undefined,
  removeDraftFile: () => undefined,
  createSession: () => session(),
  deleteSession: () => undefined,
  updateSessionTitle: () => undefined,
  updateSessionExternalSessionId: () => undefined,
  addMessageToSession: () => undefined,
  updateLastMessage: () => undefined,
  updateMessageById: () => undefined,
  providers: [],
  activeProviderId: '',
  activeModelId: '',
  defaultAgentId: 'catty',
  toolIntegrationMode: 'mcp',
  externalAgents: [],
  agentModelMap: {},
  setAgentModel: () => undefined,
  agentProviderMap: {},
  setAgentProvider: () => undefined,
  globalPermissionMode: 'autonomous',
  scopeType: 'terminal',
  scopeTargetId: 'terminal-1',
  isVisible: false,
  ...overrides,
});

test('hidden empty AI side panel can release its subtree', () => {
  const props = baseProps();

  assert.equal(hasAIChatSidePanelRetainedContent(props), false);
  assert.equal(shouldKeepAIChatSidePanelMounted(props), false);
});

test('hidden AI side panel is retained when it has draft text', () => {
  const props = baseProps({
    draftsByScope: {
      'terminal:terminal-1': draft({ text: 'hello' }),
    },
  });

  assert.equal(hasAIChatSidePanelRetainedContent(props), true);
  assert.equal(shouldKeepAIChatSidePanelMounted(props), true);
});

test('hidden AI side panel is retained when it has session messages', () => {
  const props = baseProps({
    activeSessionIdMap: { 'terminal:terminal-1': 'session-1' },
    sessions: [
      session({
        messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
      }),
    ],
  });

  assert.equal(hasAIChatSidePanelRetainedContent(props), true);
  assert.equal(shouldKeepAIChatSidePanelMounted(props), true);
});

test('visible AI side panel is always mounted even when empty', () => {
  assert.equal(shouldKeepAIChatSidePanelMounted(baseProps({ isVisible: true })), true);
});

test('AI side panel re-renders when retained content becomes visible again', () => {
  const hiddenProps = baseProps({
    isVisible: false,
    draftsByScope: {
      'terminal:terminal-1': draft({ text: 'hello' }),
    },
  });

  assert.equal(aiChatSidePanelPropsAreEqual(
    hiddenProps,
    { ...hiddenProps, isVisible: true },
  ), false);
});
