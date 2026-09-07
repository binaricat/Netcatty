import { getExternalAgentSdkBackend } from '../../managedAgents';
import {
  runSdkAgentTurn,
  steerSdkAgentTurn,
  type SdkAgentCallbacks,
} from '../../sdkAgentAdapter';
import {
  getNetcattyBridge,
  generateId,
  resolveUserSkillsContext,
  isToolResultError,
} from '../../aiChatStreamingSupport';
import type { AgentActivity, AgentUsage, ChatMessage } from '../../types';
import type {
  ExternalTurnInput,
  TurnDriver,
  TurnDriverContext,
  TurnSteerInput,
  TurnSteerResult,
} from './types';
import { resolveEstimatedUsageFallback, upsertAgentActivity } from './externalSdkEventState';
import {
  clearCodebuddyElicitationsForChat,
  completeCodebuddyElicitation,
  registerCodebuddyElicitation,
} from '../../shared/codebuddyElicitations';

interface LiveExternalTurn {
  requestId: string;
  sessionId: string;
  signal: AbortSignal;
  agentConfig: ExternalTurnInput['agentConfig'];
  steer(input: TurnSteerInput): Promise<TurnSteerResult>;
  ended: boolean;
}

export class ExternalSdkTurnDriver implements TurnDriver {
  readonly backend = 'external-sdk' as const;
  private readonly liveTurns = new Map<string, LiveExternalTurn>();

  async run(input: import('./types').TurnInput, ctx: TurnDriverContext): Promise<void> {
    if (input.backend !== 'external-sdk') {
      throw new Error('ExternalSdkTurnDriver received non-external input');
    }
    try {
      await runExternalTurn(input, ctx, (liveTurn) => {
        this.liveTurns.set(input.chatSessionId, liveTurn);
      });
    } finally {
      this.liveTurns.delete(input.chatSessionId);
    }
  }

  async steer(input: TurnSteerInput): Promise<TurnSteerResult> {
    const liveTurn = this.liveTurns.get(input.chatSessionId);
    if (!liveTurn || liveTurn.ended) return { status: 'inactive' };
    if (
      getExternalAgentSdkBackend(liveTurn.agentConfig) !== 'codex'
      || liveTurn.agentConfig.codexRuntime !== 'app-server'
    ) {
      return { status: 'unsupported' };
    }
    return liveTurn.steer(input);
  }

  abort(): void {
    // Abort is handled via AbortSignal on the turn input.
  }
}

async function runExternalTurn(
  input: ExternalTurnInput,
  ctx: TurnDriverContext,
  registerLiveTurn: (liveTurn: LiveExternalTurn) => void,
): Promise<void> {
  const {
    chatSessionId: sessionId,
    assistantMsgId,
    userText: trimmed,
    signal,
    agentConfig,
    attachedImages,
    context,
    bridge,
    ui,
  } = input;

  const netcattyBridge = bridge ?? getNetcattyBridge();
  const sdkBackend = getExternalAgentSdkBackend(agentConfig);

  if (!sdkBackend || !netcattyBridge) {
    ui.reportStreamError(
      sessionId,
      signal,
      'This agent has no SDK backend configured. Re-discover it in Settings -> AI.',
    );
    ui.setStreamingForScope(sessionId, false);
    return;
  }

  const userSkillsContext = await resolveUserSkillsContext(
    netcattyBridge,
    trimmed,
    context.selectedUserSkillSlugs,
  );

  const requestId = ctx.turnId;
  ui.setStreamingForScope(sessionId, true);

  if (netcattyBridge.aiMcpUpdateSessions) {
    await netcattyBridge.aiMcpUpdateSessions(context.terminalSessions, sessionId);
  }

  let needsNewAssistantMsg = false;
  let activeAssistantMessageId = assistantMsgId;
  let steerInFlight = false;
  let ended = false;
  interface BufferedUiOperation {
    operation: () => void;
    flushBeforeSteerBoundary: boolean;
  }
  const bufferedUiOperations: BufferedUiOperation[] = [];

  const runOrBufferUiOperation = (
    operation: () => void,
    options: { flushBeforeSteerBoundary?: boolean } = {},
  ) => {
    if (steerInFlight) {
      bufferedUiOperations.push({
        operation,
        flushBeforeSteerBoundary: options.flushBeforeSteerBoundary === true,
      });
      return;
    }
    operation();
  };
  const flushBufferedUiOperations = (
    shouldFlush: (entry: BufferedUiOperation) => boolean = () => true,
  ) => {
    const operations = bufferedUiOperations.splice(0);
    operations.forEach((entry) => {
      if (shouldFlush(entry)) {
        entry.operation();
      } else {
        bufferedUiOperations.push(entry);
      }
    });
  };
  const maybeCreateAssistantMsg = () => {
    if (!needsNewAssistantMsg) return;
    needsNewAssistantMsg = false;
    activeAssistantMessageId = generateId();
    ui.addMessageToSession(sessionId, {
      id: activeAssistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      model: agentConfig.name || 'external',
    });
  };
  const updateActiveAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
    maybeCreateAssistantMsg();
    ui.updateMessageById(sessionId, activeAssistantMessageId, updater);
  };
  let pendingText = '';
  let rafId: number | null = null;
  const appendTextToActiveAssistant = (textChunk: string) => {
    updateActiveAssistant(msg => ({
      ...msg,
      content: msg.content + textChunk,
      statusText: undefined,
      thinkingDurationMs: msg.thinking && !msg.thinkingDurationMs
        ? Date.now() - msg.timestamp : msg.thinkingDurationMs,
    }));
  };
  const flushPendingText = () => {
    if (pendingText) {
      const textChunk = pendingText;
      pendingText = '';
      runOrBufferUiOperation(() => appendTextToActiveAssistant(textChunk));
    }
    rafId = null;
  };
  const scheduleFrame = (cb: () => void): number => (
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : setTimeout(cb, 0) as unknown as number
  );
  const cancelFrame = (id: number): void => {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id);
      return;
    }
    clearTimeout(id);
  };
  const cancelPendingTextFlush = () => {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
  };
  const enqueueTextDelta = (textChunk: string) => {
    if (!textChunk) return;
    // While steering buffers UI ops, skip rAF so text enters the buffer immediately.
    if (steerInFlight) {
      runOrBufferUiOperation(() => appendTextToActiveAssistant(textChunk));
      return;
    }
    pendingText += textChunk;
    if (rafId === null) {
      rafId = scheduleFrame(flushPendingText);
    }
  };
  const flushTextBeforeNonTextEvent = () => {
    cancelPendingTextFlush();
    flushPendingText();
  };

  const toolNamesByCallId = new Map<string, string>();
  const toolCallMessageIds = new Map<string, string>();
  const activityMessageIds = new Map<string, string>();
  let actualUsageReported = false;
  const updateActivity = (activity: AgentActivity) => {
    const activityMessageId = activityMessageIds.get(activity.id);
    if (activityMessageId) {
      ui.updateMessageById(sessionId, activityMessageId, msg => ({
        ...msg,
        agentActivities: upsertAgentActivity(msg.agentActivities, activity),
        statusText: undefined,
      }));
      return;
    }

    maybeCreateAssistantMsg();
    activityMessageIds.set(activity.id, activeAssistantMessageId);
    ui.updateMessageById(sessionId, activeAssistantMessageId, msg => ({
      ...msg,
      agentActivities: upsertAgentActivity(msg.agentActivities, activity),
      statusText: undefined,
    }));
  };
  const updateUsage = (usage: AgentUsage) => {
    updateActiveAssistant(msg => ({ ...msg, usage }));
  };
  const callbacks: SdkAgentCallbacks = {
    onTextDelta: (text: string) => {
      enqueueTextDelta(text);
    },
    onThinkingDelta: (text: string) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => {
        updateActiveAssistant(msg => ({
          ...msg,
          thinking: (msg.thinking || '') + text,
        }));
      });
    },
    onThinkingDone: () => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => {
        updateActiveAssistant(msg => ({
          ...msg,
          thinkingDurationMs: msg.thinkingDurationMs || (Date.now() - msg.timestamp),
        }));
      });
    },
    onToolCall: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => {
        const id = toolCallId || `tc_${Date.now()}`;
        maybeCreateAssistantMsg();
        toolNamesByCallId.set(id, toolName);
        toolCallMessageIds.set(id, activeAssistantMessageId);
        ui.updateMessageById(sessionId, activeAssistantMessageId, msg => ({
          ...msg,
          toolCalls: [...(msg.toolCalls || []), { id, name: toolName, arguments: args }],
          executionStatus: 'running',
          statusText: undefined,
        }));
      });
    },
    onToolResult: (toolCallId: string, result: string, toolName?: string) => {
      flushTextBeforeNonTextEvent();
      const existingToolCallMessageId = toolCallMessageIds.get(toolCallId);
      runOrBufferUiOperation(() => {
        const effectiveToolName = toolName ?? toolNamesByCallId.get(toolCallId);
        const toolCallMessageId = existingToolCallMessageId
          ?? toolCallMessageIds.get(toolCallId);
        const updateToolCallOwner = (msg: ChatMessage) => {
          if (msg.role !== 'assistant' || msg.executionStatus !== 'running') return msg;
          const updatedToolCalls = effectiveToolName && !effectiveToolName.includes('sdk_agent_dynamic_tool') && msg.toolCalls
            ? msg.toolCalls.map(tc => tc.id === toolCallId && !tc.name ? { ...tc, name: effectiveToolName } : tc)
            : msg.toolCalls;
          return { ...msg, toolCalls: updatedToolCalls, executionStatus: 'completed', statusText: undefined };
        };
        if (toolCallMessageId) {
          ui.updateMessageById(sessionId, toolCallMessageId, updateToolCallOwner);
        } else {
          updateActiveAssistant(updateToolCallOwner);
        }
        ui.addMessageToSession(sessionId, {
          id: generateId(),
          role: 'tool',
          content: '',
          toolResults: [{
            toolCallId,
            toolName: effectiveToolName,
            content: result,
            isError: isToolResultError(result),
          }],
          timestamp: Date.now(),
          executionStatus: 'completed',
        });
        needsNewAssistantMsg = true;
      }, {
        // A result for a tool call already rendered before steering belongs to
        // that original assistant segment. Commit it before adding the steer
        // user/continuation boundary so tool-call history stays contiguous.
        flushBeforeSteerBoundary: existingToolCallMessageId !== undefined,
      });
    },
    onFileChange: (activity) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => updateActivity(activity));
    },
    onWebSearch: (activity) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => updateActivity(activity));
    },
    onPlanUpdate: (activity) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => updateActivity(activity));
    },
    onWarning: (activity) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => updateActivity(activity));
    },
    onUsage: (usage: AgentUsage) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => {
        actualUsageReported = true;
        updateUsage(usage);
      });
    },
    onStatus: (message: string) => {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => {
        updateActiveAssistant(msg => ({ ...msg, statusText: message }));
      });
    },
    onHook: (hookEvent: string, payload: Record<string, unknown>) => {
      // Surface lifecycle hooks as status text so the user sees tool activity.
      const toolName = (payload.toolName as string) || '';
      if (hookEvent === 'PreToolUse' && toolName) {
        flushTextBeforeNonTextEvent();
        runOrBufferUiOperation(() => {
          updateActiveAssistant(msg => ({ ...msg, statusText: `Running ${toolName}…` }));
        });
      } else if (hookEvent === 'Notification') {
        const message = (payload.message as string) || '';
        if (message) {
          flushTextBeforeNonTextEvent();
          runOrBufferUiOperation(() => {
            updateActiveAssistant(msg => ({ ...msg, statusText: message }));
          });
        }
      }
    },
    onElicitationCreate: (elicitationId: string, request: Record<string, unknown>) => {
      registerCodebuddyElicitation({
        elicitationId,
        chatSessionId: sessionId,
        request,
      });
    },
    onElicitationComplete: (notification) => {
      completeCodebuddyElicitation(notification);
    },
    onSessionId: (externalSessionId: string) => {
      context.updateExternalSessionId?.(sessionId, externalSessionId);
    },
    onError: (error: string) => {
      flushTextBeforeNonTextEvent();
      ui.reportStreamError(sessionId, signal, error);
      ui.setStreamingForScope(sessionId, false);
    },
    onDone: () => {
      flushTextBeforeNonTextEvent();
    },
  };

  const liveTurn: LiveExternalTurn = {
    requestId,
    sessionId,
    signal,
    agentConfig,
    ended: false,
    async steer(steerInput) {
      if (steerInFlight) return { status: 'busy' };
      if (ended || signal.aborted) return { status: 'cancelled' };
      // Commit any rAF-batched text before steering buffers UI ops.
      flushTextBeforeNonTextEvent();
      steerInFlight = true;
      const result = await steerSdkAgentTurn(
        netcattyBridge,
        requestId,
        sessionId,
        steerInput.prompt,
        steerInput.attachedImages.length > 0 ? steerInput.attachedImages : undefined,
        steerInput.userMessageId,
      );

      if (result.status === 'accepted' && !ended && !signal.aborted) {
        flushBufferedUiOperations(entry => entry.flushBeforeSteerBoundary);
        ui.addMessageToSession(sessionId, {
          id: steerInput.userMessageId,
          role: 'user',
          content: steerInput.userText,
          ...(steerInput.attachments?.length ? { attachments: steerInput.attachments } : {}),
          timestamp: Date.now(),
        });
        const continuationMessageId = generateId();
        ui.addMessageToSession(sessionId, {
          id: continuationMessageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model: agentConfig.name || 'external',
        });
        activeAssistantMessageId = continuationMessageId;
        needsNewAssistantMsg = false;
        steerInFlight = false;
        flushBufferedUiOperations();
        return { status: 'accepted', assistantMessageId: continuationMessageId };
      }

      steerInFlight = false;
      flushBufferedUiOperations();
      if (result.status === 'accepted') return { status: 'cancelled' };
      return result;
    },
  };
  registerLiveTurn(liveTurn);

  try {
    await runSdkAgentTurn(
      netcattyBridge,
      requestId,
      sessionId,
      agentConfig,
      trimmed,
      callbacks,
      signal,
      undefined,
      context.selectedAgentModel,
      context.existingSessionId,
      context.historyMessages,
      attachedImages.length > 0 ? attachedImages : undefined,
      context.toolIntegrationMode,
      context.defaultTargetSession,
      userSkillsContext,
      context.permissionMode,
      {
        traceSink: (event) => ctx.emit(event),
        skipHarnessTrace: true,
      },
    );

    const estimatedUsage = resolveEstimatedUsageFallback(trimmed, actualUsageReported);
    if (estimatedUsage) {
      flushTextBeforeNonTextEvent();
      runOrBufferUiOperation(() => updateUsage(estimatedUsage));
      ctx.emit({
        id: `usage-${ctx.turnId}`,
        type: 'usage',
        promptTokens: estimatedUsage.inputTokens,
        completionTokens: estimatedUsage.outputTokens,
        totalTokens: estimatedUsage.totalTokens,
        estimated: true,
      } as import('../types').AgentEvent);
    }
  } finally {
    ended = true;
    liveTurn.ended = true;
    flushTextBeforeNonTextEvent();
    clearCodebuddyElicitationsForChat(sessionId);
    if (steerInFlight) {
      steerInFlight = false;
      flushBufferedUiOperations();
    }
    ui.setStreamingForScope(sessionId, false);
  }
}

export const externalSdkTurnDriver = new ExternalSdkTurnDriver();
