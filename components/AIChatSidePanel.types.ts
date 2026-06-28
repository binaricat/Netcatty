import type {
  AIDraft,
  AIPanelView,
  AIPermissionMode,
  AIToolIntegrationMode,
  AISession,
  AISessionScope,
  ChatMessage,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../infrastructure/ai/types';
import type { AIQuickMessage } from '../infrastructure/ai/quickMessages';
import type { ExecutorContext } from '../infrastructure/ai/cattyAgent/executor';
import type { Host, Snippet, VaultNote } from '../types';

// -------------------------------------------------------------------
// Props
// -------------------------------------------------------------------

export interface AIChatSidePanelProps {
  // Session state (per-scope)
  sessions: AISession[];
  activeSessionIdMap: Record<string, string | null>;
  draftsByScope: Partial<Record<string, AIDraft>>;
  panelViewByScope: Partial<Record<string, AIPanelView>>;
  setActiveSessionId: (scopeKey: string, id: string | null) => void;
  ensureDraftForScope: (scopeKey: string, agentId: string) => void;
  updateDraft: (
    scopeKey: string,
    fallbackAgentId: string,
    updater: (draft: AIDraft) => AIDraft,
  ) => void;
  showDraftView: (scopeKey: string) => void;
  showSessionView: (scopeKey: string, sessionId: string) => void;
  clearDraftForScope: (scopeKey: string) => void;
  addDraftFiles: (scopeKey: string, fallbackAgentId: string, inputFiles: File[]) => Promise<void>;
  removeDraftFile: (scopeKey: string, fallbackAgentId: string, fileId: string) => void;
  createSession: (scope: AISessionScope, agentId?: string) => AISession;
  deleteSession: (sessionId: string, scopeKey?: string) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionExternalSessionId: (sessionId: string, externalSessionId: string | undefined) => void;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (
    sessionId: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  updateMessageById: (
    sessionId: string,
    messageId: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  // Provider config
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModelId: string;

  // Agent info
  defaultAgentId: string;
  toolIntegrationMode: AIToolIntegrationMode;
  externalAgents: ExternalAgentConfig[];
  setExternalAgents?: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void;
  agentModelMap: Record<string, string>;
  setAgentModel: (agentId: string, modelId: string) => void;
  agentProviderMap: Record<string, string>;
  setAgentProvider: (agentId: string, providerId: string) => void;

  // Safety
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode?: (mode: AIPermissionMode) => void;
  commandBlocklist?: string[];
  commandTimeout?: number;
  maxIterations?: number;

  // Web search
  webSearchConfig?: WebSearchConfig | null;

  // Quick messages (slash prompts)
  quickMessages?: AIQuickMessage[];

  // Context
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeHostIds?: string[];
  scopeLabel?: string;

  // Terminal session context (from parent)
  terminalSessions?: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    protocol?: string;
    shellType?: string;
    deviceType?: string;
    connected: boolean;
  }>;
  resolveExecutorContext?: (scope: {
    type: 'terminal' | 'workspace';
    targetId?: string;
    label?: string;
  }) => ExecutorContext;

  // Visibility
  isVisible?: boolean;

  // Vault artifact navigation (from AI chat tool results)
  notes?: VaultNote[];
  hosts?: Host[];
  snippets?: Snippet[];
  onOpenVaultNote?: (noteId: string) => void;
  onOpenVaultHost?: (hostId: string) => void;
  onOpenVaultSnippet?: (snippetId: string) => void;
  onOpenVaultSection?: (section: 'notes' | 'hosts' | 'snippets') => void;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

// -------------------------------------------------------------------
// Component
// -------------------------------------------------------------------
