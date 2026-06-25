/**
 * Unified agent harness event protocol.
 * Catty (Vercel AI SDK) and external SDK drivers emit the same shapes.
 */

export type AgentEventType =
  | 'turn_start'
  | 'model_delta'
  | 'reasoning_delta'
  | 'tool_call'
  | 'tool_result'
  | 'approval_requested'
  | 'approval_resolved'
  | 'compaction'
  | 'usage'
  | 'error'
  | 'turn_end';

export type AgentBackend = 'catty' | 'external-sdk';

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

export type ContextPrepareTrigger = 'pre-turn' | '413-retry' | 'force';

export interface AgentEventBase {
  id: string;
  sessionId: string;
  chatSessionId?: string;
  backend: AgentBackend;
  timestamp: number;
  turnId?: string;
}

export interface TurnStartEvent extends AgentEventBase {
  type: 'turn_start';
  backendLabel?: string;
}

export interface ModelDeltaEvent extends AgentEventBase {
  type: 'model_delta';
  text: string;
}

export interface ReasoningDeltaEvent extends AgentEventBase {
  type: 'reasoning_delta';
  text: string;
}

export interface ToolCallEvent extends AgentEventBase {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  toolCallId: string;
  toolName?: string;
  result: string;
  isError?: boolean;
}

export interface ApprovalRequestedEvent extends AgentEventBase {
  type: 'approval_requested';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ApprovalResolvedEvent extends AgentEventBase {
  type: 'approval_resolved';
  toolCallId: string;
  toolName: string;
  outcome: ApprovalOutcome;
  persistedGrantId?: string;
}

export type TokenEstimatorKind = 'chars-div-4' | 'openai-heuristic' | 'anthropic-heuristic' | 'google-heuristic';

export interface CompactionTrace {
  trigger: ContextPrepareTrigger;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  compressedMessageCount: number;
  retainedTailCount: number;
  summaryLength?: number;
  didTypedCompression: boolean;
  didLlmSummarize: boolean;
  did413Fallback: boolean;
  estimatorKind?: TokenEstimatorKind;
}

export interface CompactionEvent extends AgentEventBase {
  type: 'compaction';
  trace: CompactionTrace;
}

export interface ErrorEvent extends AgentEventBase {
  type: 'error';
  message: string;
  code?: string;
  recoverable?: boolean;
}

export interface UsageEvent extends AgentEventBase {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
}

export interface TurnEndEvent extends AgentEventBase {
  type: 'turn_end';
  reason?: 'completed' | 'aborted' | 'error';
}

export type AgentEvent =
  | TurnStartEvent
  | ModelDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | CompactionEvent
  | UsageEvent
  | ErrorEvent
  | TurnEndEvent;

export type AgentEventListener = (event: AgentEvent) => void;

export interface ContextPrepareResult {
  messages: import('ai').ModelMessage[];
  didAdjust: boolean;
  trace?: CompactionTrace;
}

export interface ExternalBridgeHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}
