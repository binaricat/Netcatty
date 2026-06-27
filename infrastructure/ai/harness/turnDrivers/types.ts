import type { ModelMessage } from 'ai';
import type {
  AIPermissionMode,
  AIToolIntegrationMode,
  AISession,
  ChatMessage,
  ChatMessageAttachment,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../../types';
import type { ExecutorContext } from '../../cattyAgent/executor';
import type { AgentBackend, AgentEvent, AgentEventListener } from '../types';
import type { ToolOutputStore } from '../toolOutputStore';
import type { ToolResultDedup } from '../toolResultDedup';
import type { SessionStateStore } from '../sessionState';
import type { DefaultTargetSessionHint } from '../../sdkAgentAdapter';
import type { AgentStopBridge } from '../agentStop';

export interface TerminalSessionInfo {
  sessionId: string;
  hostId?: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
  hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
  activePortForwards?: Array<{
    ruleId: string;
    label?: string;
    type?: string;
    localPort?: number;
    status?: string;
  }>;
}

export interface TurnUiCallbacks {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  reportStreamError: (sessionId: string, abortSignal: AbortSignal, err: unknown) => void;
  setStreamingForScope: (key: string, val: boolean) => void;
  getLatestSession?: (sessionId: string) => AISession | undefined;
}

export interface CattyTurnContext {
  activeProvider: ProviderConfig | undefined;
  activeModelId: string;
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeLabel?: string;
  globalPermissionMode: AIPermissionMode;
  permissionMode?: AIPermissionMode;
  commandBlocklist?: string[];
  commandTimeout?: number;
  terminalSessions: TerminalSessionInfo[];
  webSearchConfig?: WebSearchConfig | null;
  getExecutorContext?: () => ExecutorContext;
  autoTitleSession: (sessionId: string, text: string) => void;
  titleText?: string;
  selectedUserSkillSlugs?: string[];
}

export interface ExternalTurnContext {
  existingSessionId?: string;
  updateExternalSessionId?: (sessionId: string, externalSessionId: string | undefined) => void;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  terminalSessions: TerminalSessionInfo[];
  defaultTargetSession?: DefaultTargetSessionHint;
  providers: ProviderConfig[];
  selectedAgentModel?: string;
  toolIntegrationMode: AIToolIntegrationMode;
  selectedUserSkillSlugs?: string[];
}

export interface CattyTurnInput {
  backend: 'catty';
  chatSessionId: string;
  sendScopeKey: string;
  userText: string;
  signal: AbortSignal;
  currentSession: AISession | undefined;
  assistantMsgId: string;
  context: CattyTurnContext;
  attachments?: ChatMessageAttachment[];
  maxIterations: number;
  bridge?: AgentStopBridge | null;
  ui: TurnUiCallbacks;
}

export interface ExternalTurnInput {
  backend: 'external-sdk';
  chatSessionId: string;
  userText: string;
  signal: AbortSignal;
  agentConfig: ExternalAgentConfig;
  attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>;
  context: ExternalTurnContext;
  bridge?: Record<string, (...args: unknown[]) => unknown> | null;
  ui: TurnUiCallbacks;
}

export type TurnInput = CattyTurnInput | ExternalTurnInput;

export interface TurnResult {
  turnId: string;
  reason: 'completed' | 'aborted' | 'error';
}

export interface TurnDriverContext {
  turnId: string;
  chatSessionId: string;
  sessionId: string;
  backend: AgentBackend;
  signal: AbortSignal;
  emit: (event: Omit<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'> & Partial<Pick<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'>>) => void;
  toolOutputStore: ToolOutputStore;
  toolResultDedup: ToolResultDedup;
  sessionStateStore: SessionStateStore;
  onEvent?: AgentEventListener;
}

export interface TurnDriver {
  readonly backend: AgentBackend;
  run(input: TurnInput, ctx: TurnDriverContext): Promise<void>;
  abort?(chatSessionId: string): void;
}

export interface PrepareStepContextInput {
  messages: ModelMessage[];
  stepNumber: number;
  sessionId: string;
  chatSessionId?: string;
  providerId?: string | null;
  modelId?: string | null;
  contextWindow?: number;
  reservedTokens?: number;
  maxOutputTokens?: number;
  protectRecentMessages?: number;
  toolOutputStore?: ToolOutputStore;
  runtimeContext: import('../cattyRuntimeContext').CattyRuntimeContext;
  onEvent?: AgentEventListener;
}
