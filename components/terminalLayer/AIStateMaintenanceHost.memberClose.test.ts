import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { AISession } from '../../infrastructure/ai/types';
import type { AIPanelContext } from '../../domain/buildAITerminalSessionInfo';
import type { Workspace } from '../../types';
import { installFakeIndexedDb } from '../../application/state/testSupport/fakeIndexedDb';
import {
  __flushIdbWritesForTests, __resetIdbPersistenceForTests,
  setLatestAISessionsSnapshot, setLatestAIActiveSessionMapSnapshot,
  setLatestAIDraftsByScopeSnapshot, setLatestAIPanelViewByScopeSnapshot,
} from '../../application/state/aiStateSnapshots';
import { getAISessionsSnapshot } from '../../application/state/aiSessionsStore';

// Keep the production provider, maintenance host, panels host and panel effects.
// Only terminal rendering and the chat presentation are replaced: capture the
// view actually selected by the mounted panel, including its New Chat action.
const contentUrl = `data:text/javascript,${encodeURIComponent(`
  let props;
  export function AIChatPanelContent(value) { props = value; return null; }
  export function readPanel() { return props; }
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../Terminal' && context.parentURL?.endsWith('/TerminalLayerSupport.tsx')) {
      return { url: 'data:text/javascript,export default function Terminal(){return null}', shortCircuit: true };
    }
    if (specifier === './AIChatPanelContent' && context.parentURL?.endsWith('/AIChatSidePanel.tsx')) {
      return { url: contentUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

test('mounted workspace chat survives last-member close without defeating detach or New Chat', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const globals = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(async () => {
    await __flushIdbWritesForTests();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const { I18nProvider } = await import('../../application/i18n/I18nProvider');
  const { AIStateProvider, AIStateMaintenanceHost, AIChatPanelsHost } = await import('./TerminalLayerSupport');
  await import('../AIChatSidePanel');
  const { readPanel } = await import(contentUrl);
  const scopeKey = 'workspace:workspace';

  for (const scenario of ['close', 'close-inherited', 'close-resumed', 'detach', 'detach-resumed', 'out-of-scope'] as const) {
    await t.test(scenario, async () => {
      dom.window.localStorage.clear();
      const idb = installFakeIndexedDb();
      __resetIdbPersistenceForTests();
      const chat: AISession = {
        id: `chat-${scenario}`, title: 'Inherited conversation', agentId: 'catty',
        scope: { type: 'terminal', targetId: scenario.endsWith('resumed') ? 'old-terminal' : 'terminal', hostIds: ['host'] },
        messages: [{ id: 'message', role: 'user', content: 'Keep this question', timestamp: 1 }],
        createdAt: 1, updatedAt: 2,
      };
      const activeMap = { [scopeKey]: chat.id, 'terminal:terminal': chat.id };
      setLatestAISessionsSnapshot([chat]);
      setLatestAIActiveSessionMapSnapshot(activeMap);
      setLatestAIDraftsByScopeSnapshot({});
      setLatestAIPanelViewByScopeSnapshot(scenario === 'close-inherited' ? {} : {
        [scopeKey]: { mode: 'session', sessionId: chat.id },
      });
      dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify([chat]));
      dom.window.localStorage.setItem('netcatty_ai_active_session_map_v1', JSON.stringify(activeMap));
      let workspace: Workspace = {
        id: 'workspace', title: 'Workspace', anchorChatId: chat.id, focusedSessionId: 'terminal',
        root: { id: 'pane', type: 'pane', sessionId: 'terminal' },
      };
      let liveIds = new Set(['workspace', 'terminal']);
      let context: AIPanelContext = {
        scopeType: 'workspace', scopeTargetId: 'workspace', scopeLabel: 'Workspace', scopeHostIds: ['host'],
        focusedSessionId: 'terminal', terminalSessions: [{ sessionId: 'terminal', hostId: 'host', status: 'connected' } as AIPanelContext['terminalSessions'][number]],
      };
      const container = dom.window.document.createElement('div');
      dom.window.document.body.append(container);
      const root = createRoot(container);
      const render = () => React.createElement(I18nProvider, null,
        React.createElement(AIStateProvider, null,
          React.createElement(AIStateMaintenanceHost, { workspaces: [workspace], validAIScopeTargetIds: liveIds }),
          React.createElement(AIChatPanelsHost, {
            mountedTabIds: ['workspace'], activeTabId: 'workspace', activeSidePanelTab: 'ai',
            liveScopeTargetIds: liveIds, contextsByTabId: new Map([['workspace', context]]),
            resolveExecutorContext: () => ({}) as never, notes: [], hosts: [], snippets: [], workspaces: [workspace],
          }),
        ),
      );
      try {
        await act(async () => root.render(render()));
        assert.equal(readPanel().activeSessionId, chat.id);
        if (scenario !== 'close-inherited') assert.equal(getAISessionsSnapshot().panelViewByScope[scopeKey]?.mode, 'session');

        if (scenario === 'out-of-scope') {
          // No member loss/handoff: a panel displaying the wrong scope must
          // still clear its explicit session instead of keeping global history.
          context = { ...context, terminalSessions: [], focusedSessionId: undefined };
        } else {
          workspace = { ...workspace, focusedSessionId: undefined,
            root: { id: 'empty', type: 'split', direction: 'vertical', children: [], sizes: [] } };
          liveIds = new Set(scenario.startsWith('close') ? ['workspace'] : ['workspace', 'terminal']);
          context = { ...context, terminalSessions: [], focusedSessionId: undefined };
        }
        await act(async () => root.render(render()));
        const snapshot = getAISessionsSnapshot();
        if (scenario.startsWith('close')) {
          assert.equal(snapshot.sessions.find(session => session.id === chat.id)?.scope.type, 'workspace');
          if (scenario !== 'close-inherited') assert.equal(snapshot.panelViewByScope[scopeKey]?.mode, 'session', 'passive normalization must not overwrite the handoff');
          else assert.notEqual(snapshot.panelViewByScope[scopeKey]?.mode, 'draft');
          assert.equal(snapshot.activeSessionIdMap[scopeKey], chat.id);
          assert.equal(readPanel().activeSessionId, chat.id);
          assert.equal(readPanel().messages[0].content, 'Keep this question');
          // No provider is configured: the real send path records the follow-up
          // and a local configuration error without contacting any model.
          readPanel().setInputValue('Continue after closing the terminal');
          await act(async () => readPanel().handleSend());
          const afterSend = getAISessionsSnapshot();
          assert.deepEqual(afterSend.sessions.map(session => session.id), [chat.id], 'follow-up must not create a new chat');
          assert.ok(afterSend.sessions[0].messages.some(message => message.content === 'Continue after closing the terminal'));
          await act(async () => readPanel().handleNewChat());
          assert.equal(getAISessionsSnapshot().panelViewByScope[scopeKey]?.mode, 'draft');
          assert.ok(getAISessionsSnapshot().activeSessionIdMap[scopeKey] == null);
        } else {
          assert.equal(snapshot.panelViewByScope[scopeKey]?.mode, 'draft');
          assert.equal(snapshot.activeSessionIdMap[scopeKey], null);
          assert.equal(snapshot.sessions.find(session => session.id === chat.id)?.scope.type, 'terminal');
          if (scenario.startsWith('detach')) assert.equal(snapshot.activeSessionIdMap['terminal:terminal'], chat.id);
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
        await __flushIdbWritesForTests();
        idb.restore();
      }
    });
  }
});
