import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../application/i18n/I18nProvider.tsx';
import type { AIDraft, AISession } from '../infrastructure/ai/types';
import { TooltipProvider } from './ui/tooltip.tsx';
import {
  aiChatSidePanelPropsAreEqual,
  AIChatSidePanel,
  hasAIChatSidePanelRetainedContent,
  shouldKeepAIChatSidePanelMounted,
} from './AIChatSidePanel.tsx';
import type { AIChatSidePanelProps } from './AIChatSidePanel.types.ts';

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function installLocalStorage(): LocalStorageMock {
  const store = new Map<string, string>();
  const localStorage: LocalStorageMock = {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorage,
    configurable: true,
  });
  return localStorage;
}

const localStorage = installLocalStorage();

test.beforeEach(() => {
  localStorage.clear();
});

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
  persistContextCompaction: () => undefined,
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
  agentThinkingMap: {},
  setAgentThinking: () => undefined,
  globalPermissionMode: 'auto',
  scopeType: 'terminal',
  scopeTargetId: 'terminal-1',
  isVisible: false,
  ...overrides,
});

test('send preflight aborts after the panel unmounts or the scope changes', () => {
  const source = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /sendEpochRef/);
  assert.match(source, /if \(isSendStale\(\)\) return;/);
});

test('send preflight locks header agent and new-chat controls', () => {
  const panel = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');
  const content = readFileSync(new URL('./AIChatPanelContent.tsx', import.meta.url), 'utf8');
  assert.match(panel, /sending=\{isSending\}/);
  assert.match(content, /disabled=\{sending\}/);
  const selector = readFileSync(new URL('./ai/AgentSelector.tsx', import.meta.url), 'utf8');
  assert.match(selector, /if \(parked \|\| disabled\) setOpen\(false\)/);
});

test('first send awaits provider sync instead of idle-deferring it', () => {
  const source = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /await sendBridge\.aiSyncProviders\(providers\)/);
  assert.match(source, /await sendBridge\.aiSyncWebSearch\(/);
  assert.doesNotMatch(source, /scheduleWhenAiComposerIdle\(\(\) => \{\s*void bridge\.aiSyncProviders/);
});

test('send and new chat discard pending composer text', () => {
  const source = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /discardPendingComposerText/);
  assert.match(source, /if \(!options\?\.keepPendingText\) discardPendingComposerText\(\)/);
});

test('text-only draft writes do not emit AI state changes', () => {
  const source = readFileSync(new URL('../application/state/useAIState.ts', import.meta.url), 'utf8');
  assert.match(source, /draftsByScopeEqualIgnoringAllComposerText/);
  assert.match(source, /if \(textOnly\) return;/);
});

test('first composer keystroke does not create a store draft synchronously', () => {
  const source = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');
  const setter = source.slice(
    source.indexOf('const setInputValue = useCallback'),
    source.indexOf('const addFiles = useCallback'),
  );
  assert.match(setter, /pendingComposerTextRef\.current = value/);
  assert.doesNotMatch(setter, /enterScopeDraftMode/);
  assert.doesNotMatch(setter, /setTimeout/);
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

test('visible empty draft renders the input immediately without preparing state', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AIChatSidePanel, baseProps({
          isVisible: true,
          sessions: [session({ id: 'session-history' })],
          draftsByScope: {
            'terminal:terminal-1': draft(),
          },
          panelViewByScope: {
            'terminal:terminal-1': { mode: 'draft' },
          },
        })),
      ),
    ),
  );

  assert.match(markup, /textarea/);
  assert.doesNotMatch(markup, /data-section="ai-chat-panel-preparing"/);
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

test('hidden retained AI side panel keeps the composer and skips message content', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AIChatSidePanel, baseProps({
          isVisible: false,
          activeSessionIdMap: { 'terminal:terminal-1': 'session-1' },
          sessions: [
            session({
              messages: [
                { id: 'm1', role: 'user', content: 'hidden-user-message', timestamp: 1 },
                { id: 'm2', role: 'assistant', content: 'hidden-assistant-message', timestamp: 2 },
              ],
            }),
          ],
          draftsByScope: {
            'terminal:terminal-1': draft({ text: 'draft still retained' }),
          },
        })),
      ),
    ),
  );

  assert.match(markup, /data-section="ai-chat-panel-retained"/);
  assert.match(markup, /inert/);
  assert.match(markup, /aria-hidden/);
  assert.match(markup, /textarea/);
  assert.doesNotMatch(markup, /hidden-user-message/);
  assert.doesNotMatch(markup, /hidden-assistant-message/);
});

test('AI side panel re-renders when command timeout changes', () => {
  const props = baseProps({
    isVisible: true,
    commandTimeout: 60,
  });

  assert.equal(aiChatSidePanelPropsAreEqual(
    props,
    { ...props, commandTimeout: 86_400 },
  ), false);
});

test('AI side panel re-renders when response wait time changes', () => {
  const props = baseProps({
    isVisible: true,
    responseIdleTimeout: 120,
  });

  assert.equal(aiChatSidePanelPropsAreEqual(
    props,
    { ...props, responseIdleTimeout: 600 },
  ), false);
});

test('AI side panel skips re-render when only a sibling scope session object changes', () => {
  const own = session({ id: 'session-1', scope: { type: 'terminal', targetId: 'terminal-1' } });
  const siblingA = session({ id: 'session-2', scope: { type: 'terminal', targetId: 'terminal-2' } });
  const siblingB = session({ id: 'session-2', scope: { type: 'terminal', targetId: 'terminal-2' } });
  const prev = baseProps({
    isVisible: true,
    scopeType: 'terminal',
    scopeTargetId: 'terminal-1',
    sessions: [own, siblingA],
  });
  const next = {
    ...prev,
    sessions: [own, siblingB],
  };
  assert.equal(aiChatSidePanelPropsAreEqual(prev, next), true);

  const ownStreamed = session({ id: 'session-1', scope: { type: 'terminal', targetId: 'terminal-1' } });
  assert.equal(
    aiChatSidePanelPropsAreEqual(prev, { ...prev, sessions: [ownStreamed, siblingA] }),
    false,
  );
});

test('AI side panel skips re-render when only the composer draft text changes', () => {
  const empty = draft({ text: '' });
  const prev = baseProps({
    isVisible: true,
    scopeType: 'terminal',
    scopeTargetId: 'terminal-1',
    draftsByScope: {
      'terminal:terminal-1': empty,
    },
  });
  const next = {
    ...prev,
    draftsByScope: {
      'terminal:terminal-1': { ...empty, text: '你好', updatedAt: 2 },
    },
  };
  assert.equal(aiChatSidePanelPropsAreEqual(prev, next), true);
});

test('workspace AI panel memo follows visible inherited session, not nonmember terminal maps', () => {
  const visibleMemberChat = session({
    id: 'chat-visible',
    scope: { type: 'terminal', targetId: 'terminal-b', hostIds: ['host-b'] },
  });
  const hiddenFocusedChat = session({
    id: 'chat-hidden',
    scope: { type: 'terminal', targetId: 'terminal-other', hostIds: ['host-other'] },
  });
  const prev = baseProps({
    isVisible: true,
    scopeType: 'workspace',
    scopeTargetId: 'ws-1',
    focusedSessionId: 'terminal-a',
    terminalSessions: [
      {
        sessionId: 'terminal-a',
        hostId: 'host-a',
        hostname: 'a.example',
        label: 'A',
        connected: true,
      },
      {
        sessionId: 'terminal-b',
        hostId: 'host-b',
        hostname: 'b.example',
        label: 'B',
        connected: true,
      },
    ],
    activeSessionIdMap: {
      'terminal:terminal-outside': 'chat-hidden',
      'terminal:terminal-b': 'chat-visible',
    },
    sessions: [visibleMemberChat, hiddenFocusedChat],
  });
  const streamedVisible = session({
    id: 'chat-visible',
    scope: { type: 'terminal', targetId: 'terminal-b', hostIds: ['host-b'] },
    messages: [{ id: 'm1', role: 'assistant', content: 'stream', timestamp: 2 }],
  });

  assert.equal(
    aiChatSidePanelPropsAreEqual(prev, { ...prev, sessions: [streamedVisible, hiddenFocusedChat] }),
    false,
  );
});

test('merged AI panel displays a member chat resumed from an older terminal', () => {
  const resumed = session({
    id: 'resumed-chat',
    scope: { type: 'terminal', targetId: 'closed-terminal', hostIds: ['host-a'] },
    messages: [{ id: 'm1', role: 'user', content: 'keep-resumed-conversation', timestamp: 1 }],
  });
  const props = baseProps({
    isVisible: true,
    scopeType: 'workspace',
    scopeTargetId: 'merged',
    focusedSessionId: 'terminal-a',
    scopeHostIds: ['host-a'],
    terminalSessions: [{ sessionId: 'terminal-a', hostId: 'host-a', hostname: 'a', label: 'A', connected: true }],
    sessions: [resumed],
    activeSessionIdMap: { 'terminal:terminal-a': resumed.id },
  });
  const render = (panelProps: AIChatSidePanelProps) => renderToStaticMarkup(
    React.createElement(I18nProvider, { locale: 'en' },
      React.createElement(TooltipProvider, null,
        React.createElement(AIChatSidePanel, panelProps))),
  );
  // Check both the first workspace paint and the explicit merge handoff.
  assert.match(render(props), /keep-resumed-conversation/);
  assert.match(render({
    ...props,
    activeSessionIdMap: { ...props.activeSessionIdMap, 'workspace:merged': resumed.id },
    panelViewByScope: { 'workspace:merged': { mode: 'session', sessionId: resumed.id } },
  }), /keep-resumed-conversation/);
  assert.equal(aiChatSidePanelPropsAreEqual(props, {
    ...props,
    sessions: [{ ...resumed, messages: [...resumed.messages, {
      id: 'm2', role: 'assistant', content: 'continued response', timestamp: 2,
    }] }],
  }), false);
});
