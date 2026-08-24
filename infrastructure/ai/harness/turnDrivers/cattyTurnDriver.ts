import type { ModelMessage } from 'ai';
import type { OpenAIChatAssistantFields } from '../../providerContinuation';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_PROTECT_RECENT_MESSAGES,
  estimateUnknownTokens,
  findSafeChatMessageCompactionSplitIndex,
  resolveContextWindow,
} from '../../contextCompaction';
import { buildSystemPrompt } from '../../cattyAgent/systemPrompt';
import {
  isWebSearchReady,
  normalizeCommandTimeoutSeconds,
  normalizeResponseIdleTimeoutSeconds,
} from '../../types';
import {
  buildCattyReasoningProviderOptions,
  estimateReasoningOutputReserve,
} from '../../cattyReasoning';
import { createModelFromConfig } from '../../sdk/providers';
import { createCattyToolsFromCatalog } from '../capabilityTools';
import { createInitialCattyRuntimeContext } from '../cattyRuntimeContext';
import { prepareStepContext, extractLatestUserGoal } from '../contextManager';
import {
  compactCattyMessages,
  prepareCattyMessagesForStream,
} from '../cattyRuntime';
import { computeTotalInputTokens, DEFAULT_MAX_OUTPUT_TOKENS } from '../contextBudget';
import { clearChatSessionCancelled } from '../agentStop';
import { isRequestTooLargeError } from '../../errorClassifier';
import { getNetcattyBridge, generateId, resolveUserSkillsContext } from '../../aiChatStreamingSupport';
import {
  buildCattySdkMessages,
  collectOpenAIChatAssistantFieldsForMessages,
  collectPreservedTerminalWriteFingerprints,
  collectToolResultsAfterMessage,
  createContinuationContext,
} from './cattyMessageBuilder';
import { hadToolProgressBeforeRequestTooLarge, processCattyStream } from './cattyStreamProcessor';
import type { CattyTurnInput, TurnDriver, TurnDriverContext } from './types';
import { fitLargeUserInputForModel } from '../largeUserInput';
import { buildPromptContextSnapshot } from '../promptContextSnapshot';

export class CattyTurnDriver implements TurnDriver {
  readonly backend = 'catty' as const;

  async run(input: import('./types').TurnInput, ctx: TurnDriverContext): Promise<void> {
    if (input.backend !== 'catty') {
      throw new Error('CattyTurnDriver received non-catty input');
    }
    await runCattyTurn(input, ctx);
  }

  abort(): void {
    // Abort is handled via AbortSignal on the turn input.
  }
}

async function runCattyTurn(input: CattyTurnInput, ctx: TurnDriverContext): Promise<void> {
  const {
    chatSessionId: sessionId,
    userText: trimmed,
    signal,
    currentSession,
    assistantMsgId,
    context,
    attachments,
    maxIterations,
    bridge,
    ui,
  } = input;

  const netcattyBridge = (bridge ?? getNetcattyBridge()) as NonNullable<ReturnType<typeof getNetcattyBridge>>;
  const toolOutputTempBridge = netcattyBridge as typeof netcattyBridge & {
    getToolOutputPersistenceStatus?: () => Promise<{ durable: boolean; reason?: string }>;
    writeToolOutputTemp?: (
      record: import('../toolOutputStore').PersistedToolOutputRecord,
      content: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    restoreToolOutputTemp?: (
      handleId: string,
      chatSessionId: string,
    ) => Promise<{ path: string; record: import('../toolOutputStore').PersistedToolOutputRecord } | null>;
    readToolOutputTemp?: (
      path: string,
      request: import('../toolOutputStore').ReadToolOutputInput,
    ) => Promise<Omit<import('../toolOutputStore').ToolOutputReadResult, 'handleId' | 'storedChars' | 'sourceTruncated'> | null>;
    deleteToolOutputTemp?: (path: string) => Promise<{ ok: boolean }>;
    deleteChatToolOutputsTemp?: (chatSessionId: string) => Promise<{ deletedCount: number }>;
    deleteTerminalToolOutputsTemp?: (
      chatSessionId: string,
      terminalSessionId: string,
    ) => Promise<{ deletedCount: number }>;
  };
  const persistenceStatus = await toolOutputTempBridge.getToolOutputPersistenceStatus?.()
    .catch(() => ({ durable: false }));
  if (
    toolOutputTempBridge.writeToolOutputTemp
    && toolOutputTempBridge.readToolOutputTemp
    && toolOutputTempBridge.deleteToolOutputTemp
  ) {
    ctx.toolOutputStore.setPersistence?.({
      write: async (record, content) => {
        if (!persistenceStatus?.durable) {
          throw new Error(persistenceStatus?.reason || 'Secure local storage is unavailable.');
        }
        const result = await toolOutputTempBridge.writeToolOutputTemp!(record, content);
        if (!result.ok || !result.path) {
          throw new Error(result.error || 'Unable to persist tool output.');
        }
        return result.path;
      },
      restore: persistenceStatus?.durable && toolOutputTempBridge.restoreToolOutputTemp
        ? (handleId, chatSessionId) => toolOutputTempBridge.restoreToolOutputTemp!(handleId, chatSessionId)
        : undefined,
      read: (path, request) => toolOutputTempBridge.readToolOutputTemp!(path, request),
      delete: async path => {
        await toolOutputTempBridge.deleteToolOutputTemp!(path);
      },
      deleteSession: toolOutputTempBridge.deleteChatToolOutputsTemp
        ? async chatSessionId => {
          await toolOutputTempBridge.deleteChatToolOutputsTemp!(chatSessionId);
        }
        : undefined,
      deleteTerminalSession: toolOutputTempBridge.deleteTerminalToolOutputsTemp
        ? async (chatSessionId, terminalSessionId) => {
          await toolOutputTempBridge.deleteTerminalToolOutputsTemp!(chatSessionId, terminalSessionId);
        }
        : undefined,
      deleteTerminalEverywhere: toolOutputTempBridge.deleteTerminalToolOutputsEverywhereTemp
        ? async terminalSessionId => {
          await toolOutputTempBridge.deleteTerminalToolOutputsEverywhereTemp!(terminalSessionId);
        }
        : undefined,
    });
  } else {
    ctx.toolOutputStore.setPersistence?.(undefined);
  }
  await clearChatSessionCancelled(sessionId, netcattyBridge);
  if (netcattyBridge.aiMcpUpdateSessions) {
    await netcattyBridge.aiMcpUpdateSessions(context.terminalSessions, sessionId);
  }
  if (attachments?.length && netcattyBridge.aiMcpUpdateAttachments) {
    await netcattyBridge.aiMcpUpdateAttachments(attachments, sessionId);
  }
  const userSkillsContext = await resolveUserSkillsContext(
    netcattyBridge,
    trimmed,
    context.selectedUserSkillSlugs,
  );
  const modelUserText = fitLargeUserInputForModel(trimmed, sessionId, ctx.toolOutputStore);
  const getExecutorContext = context.getExecutorContext ?? (() => ({
    sessions: context.terminalSessions,
    workspaceId: context.scopeType === 'workspace' ? context.scopeTargetId : undefined,
    workspaceName: context.scopeType === 'workspace' ? context.scopeLabel : undefined,
  }));
  const toolsBundle = createCattyToolsFromCatalog(
    netcattyBridge,
    getExecutorContext,
    context.commandBlocklist,
    context.globalPermissionMode,
    context.webSearchConfig ?? undefined,
    sessionId,
    ctx.toolOutputStore,
    ctx.toolResultDedup,
  );
  const { tools } = toolsBundle;

  const systemPrompt = buildSystemPrompt({
    scopeType: context.scopeType,
    scopeLabel: context.scopeLabel,
    hosts: context.terminalSessions,
    permissionMode: context.globalPermissionMode,
    webSearchEnabled: isWebSearchReady(context.webSearchConfig),
    userSkillsContext,
  });

  if (!context.activeProvider) {
    ui.reportStreamError(sessionId, signal, 'No AI provider configured. Please configure a provider in Settings → AI.');
    return;
  }

  const activeModelId = context.activeModelId || context.activeProvider.defaultModel || '';
  const promptContext = buildPromptContextSnapshot({
    providerId: context.activeProvider.providerId,
    modelId: activeModelId,
    permissionMode: context.permissionMode ?? context.globalPermissionMode,
    scopeType: context.scopeType,
    scopeLabel: context.scopeLabel,
    toolNames: Object.keys(tools),
    selectedSkillSlugs: context.selectedUserSkillSlugs,
    systemPrompt,
    webSearchEnabled: isWebSearchReady(context.webSearchConfig),
    hostSessionIds: context.terminalSessions.map(session => session.sessionId),
  });
  ctx.emit({
    id: `context-snapshot-${ctx.turnId}`,
    type: 'context_snapshot',
    snapshot: promptContext,
  } as import('../types').AgentEvent);
  const continuationContext = createContinuationContext(
    context.activeProvider.id,
    context.activeProvider.providerId,
    activeModelId,
  );

  ui.setStreamingForScope(sessionId, true);

  try {
    const openAIChatAssistantFieldsByMessage = new Map<ModelMessage, OpenAIChatAssistantFields | undefined>();

    const buildSdkMessages = (
      allMessages: import('../../types').ChatMessage[],
      includeCurrentUserMessage: boolean,
      options: { preserveTerminalToolResults?: ReadonlySet<import('../../types').ToolResult> } = {},
      sessionContextCompaction = currentSession?.contextCompaction,
    ) => buildCattySdkMessages({
      allMessages,
      contextCompaction: sessionContextCompaction,
      includeCurrentUserMessage,
      trimmed: modelUserText,
      attachments: includeCurrentUserMessage ? attachments : undefined,
      continuationContext,
      preserveTerminalToolResults: options.preserveTerminalToolResults,
      chatSessionId: sessionId,
      toolOutputStore: ctx.toolOutputStore,
      fieldsByMessage: openAIChatAssistantFieldsByMessage,
    });

    const responseIdleTimeoutSeconds = normalizeResponseIdleTimeoutSeconds(
      context.responseIdleTimeout ?? Number.NaN,
    );
    const responseIdleTimeoutMs = responseIdleTimeoutSeconds * 1000;

    let model;
    try {
      model = createModelFromConfig(
        {
          ...context.activeProvider,
          defaultModel: activeModelId,
        },
        {
          getOpenAIChatAssistantFields: () => continuationContext.openAIChatAssistantFields,
          streamIdleTimeoutMs: responseIdleTimeoutMs,
        },
      );
    } catch (e) {
      console.error('[Catty] Model creation failed:', e);
      ui.reportStreamError(sessionId, signal, `Model creation failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const contextWindow = resolveContextWindow({
      provider: context.activeProvider,
      modelId: activeModelId,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
    const maxOutputTokens = context.activeProvider.advancedParams?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const reasoningProviderOptions = buildCattyReasoningProviderOptions(
      context.activeProvider,
      context.reasoningEffort,
      activeModelId,
    );
    const reasoningReserveTokens = estimateReasoningOutputReserve(reasoningProviderOptions);
    // Fold thinking budget into compaction maxOutput only. reservedTokens is
    // added to estimated input separately, so adding the budget there too
    // would count the same 10k/20k twice.
    const compactionMaxOutputTokens = maxOutputTokens + reasoningReserveTokens;
    const providerId = context.activeProvider.providerId;
    const outputReserveTokens = Math.min(maxOutputTokens, Math.ceil(contextWindow * 0.05));
    const getRequestReserveTokens = () => outputReserveTokens + estimateUnknownTokens({
      systemPrompt,
      toolNames: Object.keys(tools),
      openAIChatAssistantFields: Array.from(openAIChatAssistantFieldsByMessage.values()),
    }, providerId);

    const prepareMessagesForStream = (messages: ModelMessage[]): ModelMessage[] => {
      const pruned = prepareCattyMessagesForStream(messages);
      continuationContext.openAIChatAssistantFields = collectOpenAIChatAssistantFieldsForMessages(
        pruned,
        openAIChatAssistantFieldsByMessage,
      );
      return pruned;
    };

    const compactMessages = async (
      messages: ModelMessage[],
      options: {
        force?: boolean;
        compressForRequestTooLargeRetry?: boolean;
        protectRecentMessages?: number;
      },
    ) => {
      const pendingHandles = ctx.toolOutputStore.listPendingHandles(sessionId);
      const sessionStateText = ctx.sessionStateStore.toReinjectionText(sessionId);
      const result = await compactCattyMessages({
        messages,
        sessionId,
        chatSessionId: sessionId,
        provider: context.activeProvider,
        modelId: activeModelId || context.activeProvider?.defaultModel,
        reservedTokens: getRequestReserveTokens,
        maxOutputTokens: compactionMaxOutputTokens,
        model,
        toolOutputStore: ctx.toolOutputStore,
        abortSignal: signal,
        trigger: options.force ? 'force' : options.compressForRequestTooLargeRetry ? '413-retry' : 'pre-turn',
        force: options.force,
        compressForRequestTooLargeRetry: options.compressForRequestTooLargeRetry,
        protectRecentMessages: options.protectRecentMessages,
        onCompactionStart: (trigger) => {
          ctx.emit({
            id: `compaction-start-${Date.now()}`,
            type: 'compaction_start',
            sessionId,
            chatSessionId: sessionId,
            backend: 'catty',
            timestamp: Date.now(),
            trigger,
          } as import('../types').AgentEvent);
        },
        onCompaction: (trace) => {
          ctx.emit({
            id: `compaction-${Date.now()}`,
            type: 'compaction',
            trace,
          } as import('../types').AgentEvent);
          if (options.compressForRequestTooLargeRetry && trace.did413Fallback) {
            console.warn('[Catty] Request content compressed after forced context compaction.');
          }
        },
        reinjection: {
          permissionMode: context.permissionMode ?? context.globalPermissionMode,
          sessionStateText,
          sessionScopeSummary: pendingHandles.length
            ? `Pending tool output handles: ${pendingHandles.map(h => h.id).join(', ')}`
            : undefined,
        },
      });
      return result;
    };

    const emitContextSnapshot = (messages: ModelMessage[]) => {
      ctx.emit({
        id: `context-snapshot-${Date.now()}-${ctx.turnId}`,
        type: 'context_snapshot',
        snapshot: {
          ...promptContext,
          contextWindow,
          estimatedInputTokens: computeTotalInputTokens({
            messages,
            providerId,
            systemPrompt,
            toolNames: Object.keys(tools),
          }),
        },
      } as import('../types').AgentEvent);
    };

    if (context.forceCompaction) {
      // Persist a tool-safe UI-message boundary and summarize only that head
      // slice so the durable compact coordinate system matches buildCattySdkMessages.
      const uiMessages = currentSession?.messages ?? [];
      const compactedMessageCount = findSafeChatMessageCompactionSplitIndex(
        uiMessages,
        DEFAULT_PROTECT_RECENT_MESSAGES,
      );
      if (compactedMessageCount <= 0) {
        emitContextSnapshot(prepareMessagesForStream(buildSdkMessages(uiMessages, false)));
        return;
      }

      const headSdkMessages = buildSdkMessages(
        uiMessages.slice(0, compactedMessageCount),
        false,
        {},
        undefined,
      );
      const compacted = await compactMessages(headSdkMessages, {
        force: true,
        // Summarize the entire head; the protected tail lives in UI messages.
        protectRecentMessages: 0,
      });
      if (compacted.summary) {
        const nextCompaction = {
          summary: compacted.summary,
          compactedMessageCount,
        };
        ui.persistContextCompaction?.(sessionId, nextCompaction);
        emitContextSnapshot(prepareMessagesForStream(
          buildSdkMessages(uiMessages, false, {}, nextCompaction),
        ));
      } else {
        // Non-durable outcome: keep the meter honest (full current context).
        emitContextSnapshot(prepareMessagesForStream(buildSdkMessages(uiMessages, false)));
      }
      return;
    }

    let messagesForStream = buildSdkMessages(currentSession?.messages ?? [], true);
    messagesForStream = (await compactMessages(messagesForStream, {})).messages;
    messagesForStream = prepareMessagesForStream(messagesForStream);
    emitContextSnapshot(messagesForStream);

    const runtimeContext = createInitialCattyRuntimeContext({
      chatSessionId: sessionId,
      turnId: ctx.turnId,
      providerId: context.activeProvider?.providerId,
      modelId: activeModelId,
      permissionMode: context.permissionMode ?? context.globalPermissionMode,
      scopeType: context.scopeType,
      scopeLabel: context.scopeLabel,
      userGoal: extractLatestUserGoal(messagesForStream),
      promptContext,
    });
    const commandTimeoutSeconds =
      Number.isFinite(context.commandTimeout) && context.commandTimeout > 0
        ? normalizeCommandTimeoutSeconds(context.commandTimeout)
        : undefined;
    const commandTimeoutMs =
      commandTimeoutSeconds != null
        ? commandTimeoutSeconds * 1000
        : undefined;

    const runStream = async (streamMessages: ModelMessage[], streamAssistantMsgId: string) => {
      await processCattyStream({
        streamSessionId: sessionId,
        model,
        systemPrompt,
        toolsBundle,
        sdkMessages: streamMessages,
        signal,
        currentAssistantMsgId: streamAssistantMsgId,
        maxIterations,
        advancedParams: context.activeProvider?.advancedParams,
        reasoningProviderOptions,
        continuationContext,
        turnId: ctx.turnId,
        commandTimeoutMs,
        responseIdleTimeoutMs,
        runtimeContext,
        onAgentEvent: (event) => ctx.emit(event),
        prepareStep: async ({ stepNumber, messages, runtimeContext: stepRuntimeContext }) => {
          const prepared = await prepareStepContext({
            messages,
            stepNumber,
            sessionId,
            chatSessionId: sessionId,
            providerId: context.activeProvider?.providerId,
            modelId: activeModelId,
            contextWindow,
            reservedTokens: getRequestReserveTokens(),
            maxOutputTokens: compactionMaxOutputTokens,
            toolOutputStore: ctx.toolOutputStore,
            runtimeContext: stepRuntimeContext,
            onEvent: (event) => ctx.emit(event),
          });
          emitContextSnapshot(prepared.messages);
          return {
            messages: prepared.messages,
            runtimeContext: prepared.runtimeContext,
          };
        },
        ui: {
          addMessageToSession: ui.addMessageToSession,
          updateMessageById: ui.updateMessageById,
        },
      });
    };

    try {
      await runStream(messagesForStream, assistantMsgId);
    } catch (streamErr) {
      if (signal.aborted || !isRequestTooLargeError(streamErr)) {
        throw streamErr;
      }

      console.warn('[Catty] Request hit HTTP 413; forcing context compaction and retrying once.', streamErr);
      const hadToolProgress = hadToolProgressBeforeRequestTooLarge(streamErr);
      let retryBaseMessages = messagesForStream;
      let retryAssistantMsgId = assistantMsgId;
      let preservedWriteFingerprints: string[] = [];
      if (hadToolProgress) {
        const latestSession = ui.getLatestSession?.(sessionId);
        if (latestSession) {
          preservedWriteFingerprints = collectPreservedTerminalWriteFingerprints(
            latestSession.messages,
            assistantMsgId,
            sessionId,
          );
          retryBaseMessages = buildSdkMessages(latestSession.messages, false, {
            preserveTerminalToolResults: collectToolResultsAfterMessage(
              latestSession.messages,
              assistantMsgId,
            ),
          }, latestSession.contextCompaction);
        }
        retryAssistantMsgId = generateId();
        ui.addMessageToSession(sessionId, {
          id: retryAssistantMsgId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model: activeModelId || context.activeProvider?.defaultModel || '',
          providerId: context.activeProvider?.providerId,
        });
      } else {
        ui.updateMessageById(sessionId, assistantMsgId, msg => ({
          ...msg,
          content: '',
          thinking: undefined,
          thinkingDurationMs: undefined,
          providerContinuation: undefined,
          toolCalls: undefined,
          errorInfo: undefined,
          executionStatus: undefined,
          pendingApproval: undefined,
        }));
      }
      ctx.toolResultDedup.enableWriteReplay(preservedWriteFingerprints);
      const retryMessages = prepareMessagesForStream((await compactMessages(retryBaseMessages, {
        force: true,
        compressForRequestTooLargeRetry: true,
      })).messages);
      emitContextSnapshot(retryMessages);
      await runStream(retryMessages, retryAssistantMsgId);
    }
  } catch (err) {
    console.error('[Catty] streamText error:', err);
    ui.reportStreamError(sessionId, signal, err);
  } finally {
    ui.updateLastMessage(sessionId, msg => msg.statusText ? { ...msg, statusText: '' } : msg);
    ui.setStreamingForScope(sessionId, false);
    context.autoTitleSession(sessionId, context.titleText ?? trimmed);
  }
}

export const cattyTurnDriver = new CattyTurnDriver();
