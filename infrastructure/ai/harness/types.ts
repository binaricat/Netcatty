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
  | 'file_change'
  | 'web_search'
  | 'plan_update'
  | 'approval_requested'
  | 'approval_resolved'
  | 'compaction'
  | 'compaction_start'
  | 'usage'
  | 'performance'
  | 'model_call_start'
  | 'step_end'
  | 'context_snapshot'
  | 'error'
  | 'turn_end';

export type AgentBackend = 'catty' | 'external-sdk' | 'antigravity';

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

export type ContextPrepareTrigger = 'pre-turn' | '413-retry' | 'force' | 'step';

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

export interface ContextSnapshotEvent extends AgentEventBase {
  type: 'context_snapshot';
  snapshot: import('./promptContextSnapshot').PromptContextSnapshot;
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

export interface FileChangeEvent extends AgentEventBase {
  type: 'file_change';
  itemId: string;
  status: 'completed' | 'failed';
  changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>;
}

export interface WebSearchEvent extends AgentEventBase {
  type: 'web_search';
  itemId: string;
  query: string;
  status: 'running' | 'completed';
}

export interface PlanUpdateEvent extends AgentEventBase {
  type: 'plan_update';
  itemId: string;
  status: 'running' | 'completed';
  items: Array<{ text: string; completed: boolean }>;
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
  archiveHandleId?: string;
  artifactHandleId?: string;
  archiveChars?: number;
  twoPassCacheHit?: boolean;
  twoPassPrefixMessages?: number;
}

export interface CompactionEvent extends AgentEventBase {
  type: 'compaction';
  trace: CompactionTrace;
}

export interface CompactionStartEvent extends AgentEventBase {
  type: 'compaction_start';
  trigger: ContextPrepareTrigger;
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
  cachedPromptTokens?: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  estimated?: boolean;
}

export interface PerformanceEvent extends AgentEventBase {
  type: 'performance';
  responseTimeMs?: number;
  timeToFirstOutputMs?: number;
  outputTokensPerSecond?: number;
}

export interface ModelCallStartEvent extends AgentEventBase {
  type: 'model_call_start';
  callId: string;
  modelId: string;
  providerId?: string;
}

export interface StepEndEvent extends AgentEventBase {
  type: 'step_end';
  callId: string;
  stepNumber: number;
  modelId?: string;
  finishReason?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TurnEndEvent extends AgentEventBase {
  type: 'turn_end';
  reason?: 'completed' | 'aborted' | 'error';
}

export type AgentEvent =
  | TurnStartEvent
  | ContextSnapshotEvent
  | ModelDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileChangeEvent
  | WebSearchEvent
  | PlanUpdateEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | CompactionEvent
  | CompactionStartEvent
  | UsageEvent
  | PerformanceEvent
  | ModelCallStartEvent
  | StepEndEvent
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
