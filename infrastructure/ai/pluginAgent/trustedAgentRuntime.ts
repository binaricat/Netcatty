import { PLUGIN_AGENT_CAPABILITIES, type PluginAgentEvent, type PluginAgentHostRequest, type PluginAgentHostResult, type PluginAgentHostSession, type PluginAgentHostTerminal } from '@netcatty/plugin-contract';
import type { AISession, ChatMessage } from '../types';
import type { AgentEvent } from '../harness/types';
import type { AgentRuntime } from '../harness/agentRuntime';
import { getAgentRuntime } from '../harness/globalAgentRuntime';
import { stopAgentTurn } from '../harness/agentStop';
import { redactSecretsForModel } from '../harness/modelSecretRedaction';
import { getNetcattyBridge } from '../aiChatStreamingSupport';
import { ConfiguredPluginAgentBackends } from './configuredBackends';
import globalTools from '../harness/generated/globalAgentToolSpecs.json';

export const GLOBAL_PLUGIN_AGENT_CAPABILITIES = PLUGIN_AGENT_CAPABILITIES;
const tools = globalTools.filter((entry) => new Set<string>(GLOBAL_PLUGIN_AGENT_CAPABILITIES).has(entry.capabilityId));
const capabilityForTool = (name: string) => tools.find((entry) => entry.toolName === name || name.endsWith(`__${entry.toolName}`))?.capabilityId;

type Turn = {
  handle: string; requestId: string; runtimeId: string; backendHandle: string; session: PluginAgentHostSession; controller: AbortController;
  queue: PluginAgentEvent[]; done: boolean; live: boolean; reading: boolean; bytes: number;
  wake: (() => void) | null; unsubscribe: () => void; timer: ReturnType<typeof setTimeout>;
  reason?: 'completed' | 'cancelled' | 'unavailable' | 'budget-exceeded';
};

// Runs the existing AgentRuntime in the trusted application, never in a plugin.
// It owns only IPC projection/lifecycle; no new model or tool orchestration loop.
export function createTrustedPluginAgentRuntime(options: {
  isActive: () => boolean;
  chooseTargets: (signal: AbortSignal, runtimeId: string) => Promise<PluginAgentHostTerminal[]>;
  backends?: ConfiguredPluginAgentBackends;
  runtime?: AgentRuntime;
}) {
  const backends = options.backends ?? new ConfiguredPluginAgentBackends();
  const runtime = options.runtime ?? getAgentRuntime();
  const turns = new Map<string, Turn>();
  const sessionOwners = new Map<string, { runtimeId: string }>();
  let closed = false;
  const active = () => { if (closed || !options.isActive()) throw Error('Trusted Agent host unavailable'); };
  const releaseChat = (id: string, runtimeId: string) => {
    const owner = sessionOwners.get(id); if (!owner || owner.runtimeId !== runtimeId) return;
    for (const [handle, turn] of turns) if (turn.session.id === id && turn.runtimeId === runtimeId) { stop(turn); turns.delete(handle); }
    void runtime.waitForActiveTurn(id).finally(() => {
      if (sessionOwners.get(id) === owner) { runtime.clearChatSession(id); sessionOwners.delete(id); }
    });
  };
  const snapshot = (turn: Turn) => {
    // Existing stream UI deliberately clears optional fields with undefined.
    // Canonical private IPC and core documents carry JSON values only.
    const value = JSON.parse(JSON.stringify(turn.session)) as PluginAgentHostSession;
    value.messages = value.messages.map((message) => message && typeof message === 'object' && !Array.isArray(message)
      && typeof message.content === 'string' ? { ...message, content: redactSecretsForModel(message.content) } : message);
    return value;
  };
  const stop = (turn: Turn, reason: Turn['reason'] = 'cancelled') => {
    if (!turn.live) return;
    turn.live = false; turn.done = true; turn.reason = reason; turn.queue.length = 0; clearTimeout(turn.timer); turn.unsubscribe();
    // Unified Stop aborts model input, native SDK work and pending approvals.
    // Main's exact-turn delegation lease owns native/worker cancellation. Do
    // not issue broad chat-scoped IPC that could arrive after a replacement turn.
    void stopAgentTurn({ chatSessionId: turn.session.id, abortController: turn.controller,
      backend: turn.session.agentId === 'catty' ? 'catty' : 'external-sdk' }).catch(() => {});
    turn.wake?.();
  };
  const owned = (handle: string, runtimeId: string) => {
    active(); const turn = turns.get(handle);
    if (!turn || turn.runtimeId !== runtimeId) throw Error('Agent turn unavailable');
    return turn;
  };
  const push = (turn: Turn, event: PluginAgentEvent) => {
    if (!turn.live || turn.controller.signal.aborted) return;
    if (turn.queue.length >= 512) { stop(turn, 'budget-exceeded'); return; }
    turn.queue.push(event); turn.wake?.();
  };
  const emit = (turn: Turn, event: AgentEvent) => {
    if (event.chatSessionId !== turn.session.id || !turn.live || turn.controller.signal.aborted) return;
    if (event.type === 'model_delta') {
      const text = redactSecretsForModel(event.text);
      turn.bytes += new TextEncoder().encode(text).byteLength;
      if (turn.bytes > 262_144) { stop(turn, 'budget-exceeded'); return; }
      let chunk = ''; let bytes = 0;
      for (const point of text) {
        const size = new TextEncoder().encode(point).byteLength;
        if (bytes + size > 4096) { push(turn, { kind: 'text', text: chunk }); chunk = ''; bytes = 0; }
        chunk += point; bytes += size;
      }
      if (chunk) push(turn, { kind: 'text', text: chunk });
    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
      const capabilityId = capabilityForTool(event.toolName ?? '');
      if (!capabilityId) { stop(turn, 'unavailable'); return; }
      push(turn, { kind: 'activity', capabilityId,
        state: event.type === 'tool_call' ? 'started' : event.isError ? 'denied' : 'completed' });
    } else if (event.type === 'usage') {
      push(turn, { kind: 'usage', inputTokens: Math.max(0, Math.floor(event.promptTokens || 0)), outputTokens: Math.max(0, Math.floor(event.completionTokens || 0)) });
    }
  };

  return {
    async handle(request: PluginAgentHostRequest, signal: AbortSignal): Promise<PluginAgentHostResult> {
      active(); signal.throwIfAborted();
      const { runtimeId, kind } = request;
      if (kind === 'agent.backends') return { backends: backends.list(runtimeId) };
      if (kind === 'agent.targets') {
        const targets = await options.chooseTargets(signal, runtimeId);
        active(); signal.throwIfAborted(); return { targets };
      }
      if (kind === 'agent.current') {
        try { backends.resolve(request.payload.hostHandle, runtimeId); return { current: true }; }
        catch { return { current: false }; }
      }
      if (kind === 'agent.run') {
        if (turns.size >= 32) throw Error('Agent turn budget exceeded');
        const payload = request.payload;
        const backend = backends.resolve(payload.backendHandle, runtimeId);
        await backend.prepare(); active(); signal.throwIfAborted();
        if (backends.resolve(payload.backendHandle, runtimeId) !== backend) throw Error('Selected Agent configuration changed');
        if ([...turns.values()].some((entry) => entry.session.id === payload.session.id && !entry.done)) throw Error('Agent chat is busy');
        // Stop acknowledges cancellation before an asynchronous driver has
        // necessarily unwound. Reuse the runtime's existing session barrier.
        await runtime.waitForActiveTurn(payload.session.id);
        active(); signal.throwIfAborted();
        if (backends.resolve(payload.backendHandle, runtimeId) !== backend) throw Error('Selected Agent configuration changed');
        if ([...turns.values()].some((entry) => entry.session.id === payload.session.id && !entry.done)) throw Error('Agent chat is busy');
        const session = structuredClone(payload.session);
        const prior = structuredClone(session) as unknown as AISession;
        const assistantMsgId = crypto.randomUUID();
        session.messages.push({ id: crypto.randomUUID(), role: 'user', content: payload.text, timestamp: Date.now() },
          { id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now() });
        const bridge = getNetcattyBridge();
        if (!bridge) throw Error('Trusted Agent bridge unavailable');
        const controller = new AbortController(); const handle = crypto.randomUUID();
        const turn: Turn = { handle, requestId: request.requestId, runtimeId, backendHandle: payload.backendHandle, session, controller, queue: [], done: false, live: true,
          reading: false, bytes: 0, wake: null, unsubscribe: () => {}, timer: setTimeout(() => {}, 0) };
        clearTimeout(turn.timer); turn.timer = setTimeout(() => stop(turn, 'budget-exceeded'), 120_000);
        turns.set(handle, turn);
        sessionOwners.set(session.id, { runtimeId });
        turn.unsubscribe = runtime.subscribe((event) => { try { emit(turn, event); } catch { stop(turn); } });
        const update = (id: string, updater: (message: ChatMessage) => ChatMessage) => {
          if (!turn.live || controller.signal.aborted) return;
          turn.session.messages = turn.session.messages.map((value) => {
            const message = value as unknown as ChatMessage;
            return message.id === id ? updater(message) as unknown as typeof value : value;
          });
          turn.session.updatedAt = Date.now();
        };
        const ui = {
          addMessageToSession: (_id: string, message: ChatMessage) => { if (turn.live && turn.session.messages.length < 200) turn.session.messages.push(message as never); },
          updateLastMessage: (_id: string, updater: (message: ChatMessage) => ChatMessage) => {
            const last = turn.session.messages.at(-1) as unknown as ChatMessage | undefined; if (last) update(last.id, updater);
          },
          updateMessageById: (_id: string, id: string, updater: (message: ChatMessage) => ChatMessage) => update(id, updater),
          reportStreamError: () => { push(turn, { kind: 'end', reason: 'unavailable' }); },
          setStreamingForScope: () => {},
          getLatestSession: () => turn.session as unknown as AISession,
          persistContextCompaction: (_id: string, value: AISession['contextCompaction']) => { if (turn.live) turn.session.contextCompaction = value as never; },
        };
        const tagged = {
          ...bridge,
          aiExec: (id: string, command: string, chatId?: string) => bridge.aiExec(id, command, chatId, payload.delegationTag),
          aiCapability: (method: string, params: Record<string, unknown>, chatId?: string) => bridge.aiCapability!(method, params, chatId, payload.delegationTag),
          aiCattyCancelExec: (chatId: string) => bridge.aiCattyCancelExec?.(chatId, payload.delegationTag),
          aiSetChatSessionCancelled: (chatId: string, cancelled?: boolean) => bridge.aiSetChatSessionCancelled!(chatId, cancelled, payload.delegationTag),
          aiMcpUpdateSessions: (sessions: typeof payload.terminalSessions, chatId?: string) => bridge.aiMcpUpdateSessions?.(sessions.map((item) => ({ ...item, hostId: item.hostId ?? '' })), chatId, payload.delegationTag),
        };
        const common = { chatSessionId: session.id, userText: payload.text, assistantMsgId, signal: controller.signal, ui, bridge: tagged };
        const run = backend.provider
          ? runtime.runTurn({ ...common, backend: 'catty', sendScopeKey: `global:${session.id}`, currentSession: prior,
            maxIterations: payload.maxIterations, context: {
              activeProvider: backend.provider, activeModelId: backend.provider.defaultModel,
              scopeType: 'global', agentKind: 'global', delegated: true, globalPermissionMode: 'confirm',
              delegationTag: payload.delegationTag, selectedUserSkillSlugs: [],
              allowedCapabilityIds: payload.capabilities,
              terminalSessions: payload.terminalSessions,
              getExecutorContext: () => ({ sessions: payload.terminalSessions.map((item) => ({ ...item, hostId: item.hostId ?? '' })),
                readTerminalContext: async (params) => tagged.aiCapability('netcatty/readContext', params as unknown as Record<string, unknown>, session.id) as never }),
              autoTitleSession: () => {}, responseIdleTimeout: 30,
            } })
          : runtime.runTurn({ ...common, backend: 'external-sdk', agentConfig: backend.external!, attachedImages: [], context: {
              // Delegated Claude disables native session persistence. Its
              // existing driver rebuilds the prompt from this core history;
              // never resume builtin or another backend's native session ID.
              updateExternalSessionId: () => {},
              historyMessages: prior.messages.filter((message) => message.role === 'user' || message.role === 'assistant')
                .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content })),
              terminalSessions: payload.terminalSessions, providers: [], toolIntegrationMode: 'mcp', permissionMode: 'confirm',
              delegationTag: payload.delegationTag, selectedUserSkillSlugs: [], selectedAgentModel: backend.selectedModel,
            } });
        void run.then((result) => {
          push(turn, { kind: 'end', reason: result.reason === 'completed' ? 'completed' : result.reason === 'aborted' ? 'cancelled' : 'unavailable' });
        }, () => { push(turn, { kind: 'end', reason: 'unavailable' }); }).finally(() => {
          turn.done = true; turn.unsubscribe(); clearTimeout(turn.timer); turn.wake?.();
        });
        return { hostHandle: handle };
      }
      if (kind === 'agent.next') {
        const turn = owned(request.payload.hostHandle, runtimeId);
        try { backends.resolve(turn.backendHandle, runtimeId); } catch { stop(turn, 'unavailable'); }
        if (turn.reading) throw Error('Agent read already pending');
        turn.reading = true;
        const cancelled = () => stop(turn); signal.addEventListener('abort', cancelled, { once: true });
        try {
          if (!turn.queue.length && !turn.done) await new Promise<void>((resolve) => { turn.wake = resolve; });
          active(); signal.throwIfAborted();
          try { backends.resolve(turn.backendHandle, runtimeId); } catch { stop(turn, 'unavailable'); }
          const event = turn.queue.shift();
          if (event) return { done: false, event, session: snapshot(turn) };
          return { done: false, event: { kind: 'end', reason: turn.reason ?? 'completed' }, session: snapshot(turn) };
        } finally { turn.wake = null; turn.reading = false; signal.removeEventListener('abort', cancelled); }
      }
      if (kind === 'agent.stop' || kind === 'agent.release') {
        const turn = owned(request.payload.hostHandle, runtimeId); stop(turn);
        if (kind === 'agent.release') turns.delete(turn.handle);
        return { ok: true, session: snapshot(turn) };
      }
      throw Error('Unsupported Agent host request');
    },
    cancelRequest(requestId: string, runtimeId: string) {
      // A timed-out start reply may never deliver its handle to main. Correlate
      // cleanup with that exact request, including after handle() has returned.
      for (const [id, turn] of turns) if (turn.runtimeId === runtimeId && turn.requestId === requestId) { stop(turn); turns.delete(id); }
    },
    invalidateConfiguration() {
      for (const turn of turns.values()) {
        try { backends.resolve(turn.backendHandle, turn.runtimeId); } catch { stop(turn, 'unavailable'); }
      }
    },
    releaseRuntime(runtimeId: string) {
      for (const [id, turn] of turns) if (turn.runtimeId === runtimeId) { stop(turn); turns.delete(id); }
      for (const [id, owner] of sessionOwners) if (owner.runtimeId === runtimeId) {
        releaseChat(id, runtimeId);
      }
      backends.releaseRuntime(runtimeId);
    },
    releaseChat,
    shutdown() {
      closed = true; for (const turn of turns.values()) stop(turn); turns.clear(); backends.shutdown();
      for (const [id, owner] of sessionOwners) void runtime.waitForActiveTurn(id).finally(() => {
        if (sessionOwners.get(id) === owner) { runtime.clearChatSession(id); sessionOwners.delete(id); }
      });
    },
  };
}
