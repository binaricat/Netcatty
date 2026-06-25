import type { AgentEvent } from './agentEvent';
import type { ChatMessage, ToolCall } from './types';

export const DEFAULT_MAX_AGENT_TRACE_EVENTS = 2_000;

export interface TraceStore {
  events: AgentEvent[];
}

export function createTraceStore(events: AgentEvent[] = []): TraceStore {
  return { events: [...events] };
}

export function trimAgentTrace(
  events: AgentEvent[] | undefined,
  maxEvents = DEFAULT_MAX_AGENT_TRACE_EVENTS,
): AgentEvent[] {
  if (!events?.length) return [];
  return events.length > maxEvents ? events.slice(-maxEvents) : events;
}

export function appendAgentEvent(
  events: AgentEvent[] | undefined,
  event: AgentEvent,
  maxEvents = DEFAULT_MAX_AGENT_TRACE_EVENTS,
): AgentEvent[] {
  return trimAgentTrace([...(events ?? []), event], maxEvents);
}

export function appendAgentEvents(
  events: AgentEvent[] | undefined,
  nextEvents: AgentEvent[],
  maxEvents = DEFAULT_MAX_AGENT_TRACE_EVENTS,
): AgentEvent[] {
  if (nextEvents.length === 0) return trimAgentTrace(events, maxEvents);
  return trimAgentTrace([...(events ?? []), ...nextEvents], maxEvents);
}

function createAssistantMessage(event: AgentEvent): ChatMessage {
  return {
    id: `trace-assistant-${event.id}`,
    role: 'assistant',
    content: '',
    timestamp: event.timestamp,
    model: event.model,
    providerId: event.providerId as ChatMessage['providerId'],
  };
}

function updateLastAssistant(
  messages: ChatMessage[],
  event: AgentEvent,
  updater: (message: ChatMessage) => ChatMessage,
): void {
  let last = messages[messages.length - 1];
  if (!last || last.role === 'tool' || last.role === 'user' || last.role === 'system') {
    last = createAssistantMessage(event);
    messages.push(last);
  }
  messages[messages.length - 1] = updater(last);
}

function ensureToolCallId(event: Extract<AgentEvent, { type: 'tool_call' }>): string {
  return event.toolCallId || `trace-tool-${event.id}`;
}

function patchToolCallName(
  toolCalls: ToolCall[] | undefined,
  toolCallId: string,
  toolName?: string,
): ToolCall[] | undefined {
  if (!toolCalls?.length || !toolName) return toolCalls;
  return toolCalls.map(toolCall => (
    toolCall.id === toolCallId && (!toolCall.name || toolCall.name === 'unknown')
      ? { ...toolCall, name: toolName }
      : toolCall
  ));
}

export function projectAgentEventsToMessages(events: AgentEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'turn_start': {
        messages.push({
          id: `trace-user-${event.id}`,
          role: 'user',
          content: event.prompt,
          timestamp: event.timestamp,
        });
        break;
      }
      case 'model_delta': {
        if (!event.delta) break;
        updateLastAssistant(messages, event, message => ({
          ...message,
          content: message.content + event.delta,
          statusText: undefined,
        }));
        break;
      }
      case 'reasoning_delta': {
        if (event.phase === 'end') {
          updateLastAssistant(messages, event, message => ({
            ...message,
            thinkingDurationMs: message.thinkingDurationMs || (event.timestamp - message.timestamp),
          }));
          break;
        }
        if (!event.delta) break;
        updateLastAssistant(messages, event, message => ({
          ...message,
          thinking: (message.thinking || '') + event.delta,
        }));
        break;
      }
      case 'tool_call': {
        const toolCallId = ensureToolCallId(event);
        updateLastAssistant(messages, event, message => ({
          ...message,
          toolCalls: [
            ...(message.toolCalls || []),
            {
              id: toolCallId,
              name: event.toolName,
              arguments: event.args,
            },
          ],
          executionStatus: 'running',
          statusText: undefined,
        }));
        break;
      }
      case 'tool_result': {
        const previous = messages[messages.length - 1];
        if (previous?.role === 'assistant') {
          messages[messages.length - 1] = {
            ...previous,
            toolCalls: patchToolCallName(previous.toolCalls, event.toolCallId, event.toolName),
            executionStatus: 'completed',
            statusText: undefined,
          };
        }
        messages.push({
          id: `trace-tool-${event.id}`,
          role: 'tool',
          content: '',
          toolResults: [{
            toolCallId: event.toolCallId,
            content: event.output,
            isError: event.isError,
          }],
          timestamp: event.timestamp,
          executionStatus: 'completed',
        });
        break;
      }
      case 'approval_requested': {
        updateLastAssistant(messages, event, message => ({
          ...message,
          pendingApproval: {
            approvalId: event.approvalId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolArgs: event.args,
            status: 'pending',
          },
          executionStatus: 'pending',
        }));
        break;
      }
      case 'approval_resolved': {
        const status = event.approved ? 'approved' : 'denied';
        updateLastAssistant(messages, event, message => (
          message.pendingApproval?.approvalId === event.approvalId
            ? {
                ...message,
                pendingApproval: { ...message.pendingApproval, status },
                executionStatus: event.approved ? 'approved' : 'rejected',
              }
            : message
        ));
        break;
      }
      case 'error': {
        updateLastAssistant(messages, event, message => ({
          ...message,
          statusText: '',
          executionStatus: message.executionStatus === 'running' ? 'failed' : message.executionStatus,
        }));
        messages.push({
          id: `trace-error-${event.id}`,
          role: 'assistant',
          content: '',
          errorInfo: {
            type: 'agent',
            message: event.error,
            retryable: !!event.retryable,
          },
          timestamp: event.timestamp,
        });
        break;
      }
      case 'compaction':
      case 'usage':
      case 'turn_end':
        break;
      default: {
        const neverEvent: never = event;
        void neverEvent;
      }
    }
  }

  return messages;
}
