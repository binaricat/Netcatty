import { getExternalAgentSdkBackend } from '../../managedAgents';
import { runSdkAgentTurn, type SdkAgentCallbacks } from '../../sdkAgentAdapter';
import { getNetcattyBridge, generateId, resolveUserSkillsContext, isToolResultError } from '../../../../components/ai/hooks/aiChatStreamingSupport';
import type { ExternalTurnInput, TurnDriver, TurnDriverContext } from './types';

export class ExternalSdkTurnDriver implements TurnDriver {
  readonly backend = 'external-sdk' as const;

  async run(input: import('./types').TurnInput, ctx: TurnDriverContext): Promise<void> {
    if (input.backend !== 'external-sdk') {
      throw new Error('ExternalSdkTurnDriver received non-external input');
    }
    await runExternalTurn(input, ctx);
  }

  abort(): void {
    // Abort is handled via AbortSignal on the turn input.
  }
}

async function runExternalTurn(input: ExternalTurnInput, ctx: TurnDriverContext): Promise<void> {
  const {
    chatSessionId: sessionId,
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
  const maybeCreateAssistantMsg = () => {
    if (needsNewAssistantMsg) {
      needsNewAssistantMsg = false;
      ui.addMessageToSession(sessionId, {
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        model: agentConfig.name || 'external',
      });
    }
  };

  const callbacks: SdkAgentCallbacks = {
    onTextDelta: (text: string) => {
      maybeCreateAssistantMsg();
      ui.updateLastMessage(sessionId, msg => ({
        ...msg,
        content: msg.content + text,
        statusText: undefined,
        thinkingDurationMs: msg.thinking && !msg.thinkingDurationMs
          ? Date.now() - msg.timestamp : msg.thinkingDurationMs,
      }));
    },
    onThinkingDelta: (text: string) => {
      maybeCreateAssistantMsg();
      ui.updateLastMessage(sessionId, msg => ({
        ...msg,
        thinking: (msg.thinking || '') + text,
      }));
    },
    onThinkingDone: () => {
      ui.updateLastMessage(sessionId, msg => ({
        ...msg,
        thinkingDurationMs: msg.thinkingDurationMs || (Date.now() - msg.timestamp),
      }));
    },
    onToolCall: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => {
      maybeCreateAssistantMsg();
      ui.updateLastMessage(sessionId, msg => ({
        ...msg,
        toolCalls: [...(msg.toolCalls || []), { id: toolCallId || `tc_${Date.now()}`, name: toolName, arguments: args }],
        executionStatus: 'running',
        statusText: undefined,
      }));
    },
    onToolResult: (toolCallId: string, result: string, toolName?: string) => {
      ui.updateLastMessage(sessionId, msg => {
        if (msg.role !== 'assistant' || msg.executionStatus !== 'running') return msg;
        const updatedToolCalls = toolName && !toolName.includes('sdk_agent_dynamic_tool') && msg.toolCalls
          ? msg.toolCalls.map(tc => tc.id === toolCallId && !tc.name ? { ...tc, name: toolName } : tc)
          : msg.toolCalls;
        return { ...msg, toolCalls: updatedToolCalls, executionStatus: 'completed', statusText: undefined };
      });
      ui.addMessageToSession(sessionId, {
        id: generateId(),
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId, content: result, isError: isToolResultError(result) }],
        timestamp: Date.now(),
        executionStatus: 'completed',
      });
      needsNewAssistantMsg = true;
    },
    onStatus: (message: string) => {
      maybeCreateAssistantMsg();
      ui.updateLastMessage(sessionId, msg => ({ ...msg, statusText: message }));
    },
    onSessionId: (externalSessionId: string) => {
      context.updateExternalSessionId?.(sessionId, externalSessionId);
    },
    onError: (error: string) => {
      ui.reportStreamError(sessionId, signal, error);
      ui.setStreamingForScope(sessionId, false);
    },
    onDone: () => {},
  };

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
      {
        traceSink: (event) => ctx.emit(event),
        skipHarnessTrace: true,
      },
    );

    ctx.emit({
      id: `usage-${ctx.turnId}`,
      type: 'usage',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: Math.ceil(trimmed.length / 4),
      estimated: true,
    } as import('../types').AgentEvent);
  } finally {
    ui.setStreamingForScope(sessionId, false);
  }
}

export const externalSdkTurnDriver = new ExternalSdkTurnDriver();
