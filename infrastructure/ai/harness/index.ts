export type {
  AgentBackend,
  AgentEvent,
  AgentEventListener,
  AgentEventType,
  ApprovalOutcome,
  CompactionEvent,
  CompactionTrace,
  ContextPrepareResult,
  ContextPrepareTrigger,
  ExternalBridgeHistoryMessage,
  TokenEstimatorKind,
  UsageEvent,
} from './types';

export { TraceStore, globalTraceStore } from './traceStore';
export type { TraceExport } from './traceStore';

export { stopAgentTurn, clearChatSessionCancelled } from './agentStop';
export type { AgentStopBridge, StopAgentTurnParams, StopAgentTurnReason } from './agentStop';

export { AgentRuntime } from './agentRuntime';
export { globalAgentRuntime, getAgentRuntime } from './globalAgentRuntime';

export {
  estimateModelMessagesTokens,
  estimateModelMessagesTokensWithKind,
} from './tokenEstimator';
export type { EstimateModelMessagesTokensInput, EstimateModelMessagesTokensResult } from './tokenEstimator';

export { ToolOutputStore, globalToolOutputStore } from './toolOutputStore';
export type { ToolOutputHandle, StoreToolOutputInput, ReadToolOutputInput } from './toolOutputStore';

export { ToolResultDedup, hashScopeKey, previewToolResult } from './toolResultDedup';
export type { ToolResultDedupEntry } from './toolResultDedup';

export { cattyTurnDriver } from './turnDrivers/cattyTurnDriver';
export { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';
export type {
  TurnInput,
  TurnResult,
  TurnDriver,
  TurnDriverContext,
  TurnUiCallbacks,
  CattyTurnInput,
  ExternalTurnInput,
} from './turnDrivers/types';

export {
  prepareTurnContext,
  prepareStepContext,
  buildExternalBridgeContext,
  extractLatestUserGoal,
} from './contextManager';
export type { PrepareTurnContextInput, PostCompactReinjection } from './contextManager';

export { buildExternalBridgeContextMessages } from './externalBridgeContext';

export {
  fitTerminalExecuteResultForModel,
  MAX_LIVE_TERMINAL_STDOUT_CHARS,
  MAX_LIVE_TERMINAL_STDERR_CHARS,
} from './terminalCompression';
export type { TerminalExecuteResult, TerminalOutputHandle } from './terminalCompression';

export {
  encodeSdkSessionIdentity,
  parseSdkSessionIdentity,
  SDK_SESSION_ID_PREFIX,
} from './sdkSessionIdentity';
export type { SdkSessionIdentityPayload } from './sdkSessionIdentity';

export {
  mapCattyStreamChunkToAgentEvents,
  mapSdkStreamEventToAgentEvents,
  createHarnessEventSink,
} from './agentEventAdapter';
export type { StreamEventContext } from './agentEventAdapter';

export {
  compactCattyMessages,
  prepareCattyMessagesForStream,
} from './cattyRuntime';
export type { CompactCattyMessagesInput, CompactCattyMessagesResult } from './cattyRuntime';

export { createCattyToolsFromCatalog } from './capabilityTools';

export {
  PermissionGrantStore,
  buildGrantFromApproval,
  createPermissionGrantId,
  getActivePermissionGrants,
  matchPermissionGrant,
  patternMatches,
  resolveCapabilityId,
  sanitizePermissionGrants,
  setActivePermissionGrants,
} from './permissionGrants';
export type { PermissionGrantMatchContext, PermissionGrantRule } from './permissionGrants';
