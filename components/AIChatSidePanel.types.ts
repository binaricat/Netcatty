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
  /** Non-destructively branch before the last user turn; returns the branch id + restored composer content. */
  undoLastTurnInSession?: (
    sessionId: string,
    viewingScope?: Pick<AISessionScope, 'type' | 'targetId'>,
  ) => Promise<{ sessionId: string; restored: { text: string; attachments: import('../infrastructure/ai/types').UploadedFile[]; selectedUserSkillSlugs: string[] } } | null>;
  deleteSession: (sessionId: string, scopeKey?: string) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  /** Issue #4015 R2: rebind a dangling chat to this panel's scope (panel action, never agent content). */
  rebindSessionScope?: (sessionId: string, scope: { type: 'terminal' | 'workspace'; targetId: string; hostIds?: string[] }) => void;
  /** Manual durability escape hatch: export the store to a JSON file (returns the path, '' when fixed-path). With `sessionIds`, exports only those chats. */
  exportSessionsBackup?: (sessionIds?: readonly string[]) => Promise<string | null>;
  /** Import sessions from a JSON export; merges by id. Returns the imported count. */
  importSessionsBackup?: () => Promise<number>;
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
  persistContextCompaction: (
    sessionId: string,
    compaction: import('../infrastructure/ai/types').AISessionContextCompaction,
  ) => void;
  forkSessionFromMessage?: (
    sessionId: string,
    messageId: string,
    viewingScope?: Pick<AISessionScope, 'type' | 'targetId'>,
  ) => Promise<AISession | null>;
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
  agentThinkingMap: Record<string, string>;
  setAgentThinking: (agentId: string, thinkingLevel: string) => void;
  updateProvider?: (id: string, updates: Partial<ProviderConfig>) => void;

  // Safety
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode?: (mode: AIPermissionMode) => void;
  commandBlocklist?: string[];
  commandTimeout?: number;
  responseIdleTimeout?: number;
  maxIterations?: number;
  toolOutputMaxChars?: number;

  // Web search
  webSearchConfig?: WebSearchConfig | null;

  // Quick messages (slash prompts)
  quickMessages?: AIQuickMessage[];

  // Context
  scopeType: 'terminal' | 'workspace' | 'global';
  scopeTargetId?: string;
  scopeHostIds?: string[];
  scopeLabel?: string;
  /** Workspace focused pane; preferred when inheriting AI chat after merge. */
  focusedSessionId?: string;
  /** Issue #4098 phase 2: pin the AI chat a workspace scope is anchored to. */
  onSetWorkspaceAnchorChat?: (workspaceId: string, chatId: string | null) => void;
  /** Focus an already-open terminal or workspace tab and ensure its AI side panel is visible. */
  onFocusAIScopeTarget?: (target: { type: 'terminal' | 'workspace'; targetId: string }) => boolean;
  /** Live workspaces (with their anchor chat and member host IDs), used for scope titles, anchor resolution, and explicit workspace rebinds. */
  workspaces?: Array<{ id: string; title: string; anchorChatId?: string; hostIds?: string[] }>;
  /** All currently live terminal (and workspace) scope target ids. */
  liveScopeTargetIds?: Set<string>;
  /** App-wide open terminal infos (all tabs), for the global session manager's rebind targets and dangling detection. */
  appTerminalSessions?: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    connected: boolean;
    workspaceId?: string;
    hiddenFromTabs?: boolean;
  }>;

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
    type: 'terminal' | 'workspace' | 'global';
    targetId?: string;
    label?: string;
  }) => ExecutorContext;

  // Visibility
  isVisible?: boolean;

  // Plugin contextual sidebar integration (native Catty Agent + plugin tools)
  pluginContext?: import('../infrastructure/ai/pluginAiSidebarTypes').PluginAISidebarTurnContext | null;
  pluginSuggestedPrompts?: readonly import('../infrastructure/ai/pluginAiSidebarTypes').PluginAISidebarPrompt[];
  pendingPluginPrompt?: { id: number; prompt: string; autoSend?: boolean } | null;
  onPendingPluginPromptConsumed?: (id: number) => void;
  onClosePanel?: () => void;
  borderlessChrome?: boolean;

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
