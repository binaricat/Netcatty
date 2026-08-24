import React, { type Dispatch, type SetStateAction } from 'react';
import { History, Plus } from 'lucide-react';
import type { AIPermissionMode, AISession, ChatMessage, DiscoveredAgent, ExternalAgentConfig, AgentModelPreset, ProviderConfig, UploadedFile } from '../infrastructure/ai/types';
import type { Host, VaultNote } from '../types';
import type { UserSkillOption } from './ai/userSkillsState';
import type { AIQuickMessage } from '../infrastructure/ai/quickMessages';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import AgentSelector from './ai/AgentSelector';
import ChatInput from './ai/ChatInput';
import ChatMessageList from './ai/ChatMessageList';
import ConversationExport from './ai/ConversationExport';
import { SessionHistoryDrawer, formatRelativeTime } from './AIChatSessionHistoryDrawer';
import { cn } from '../lib/utils';
import { TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS } from './terminalLayer/terminalSidePanelChrome';
import {
  getAIPanelDiagnosticHiddenParts,
  getAIPanelProfilerProps,
  isAIPanelDiagnosticPartHidden,
} from './ai/aiPanelDiagnostics';

type Translate = (key: string) => string;
type ExportFormat = 'md' | 'json' | 'txt';
type TerminalSessionSummary = {
  sessionId: string;
  hostname: string;
  label: string;
  connected: boolean;
};

interface AIChatPanelContentProps {
  t: Translate;
  currentAgentId: string;
  externalAgents: ExternalAgentConfig[];
  discoveredAgents: DiscoveredAgent[];
  isDiscovering: boolean;
  handleAgentChange: (agentId: string) => void;
  handleEnableDiscoveredAgent: (agent: DiscoveredAgent) => void;
  rediscover: () => void;
  handleOpenSettings: () => void;
  activeSession: AISession | null;
  handleExport: (format: ExportFormat) => void;
  showHistory: boolean;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  handleNewChat: () => void;
  historySessions: AISession[];
  activeSessionId: string | null;
  handleSelectSession: (sessionId: string) => void;
  handleDeleteSession: (event: React.MouseEvent, sessionId: string) => void;
  messages: ChatMessage[];
  isStreaming: boolean;
  activeCompaction?: import('../application/state/useAgentCompactionUi').ActiveCompactionUi | null;
  contextUsage?: import('../application/state/useAgentCompactionUi').AgentContextUsage | null;
  inputValue: string;
  setInputValue: (value: string) => void;
  handleSend: () => void;
  handleCompact: () => void;
  canCompact?: boolean;
  handleSteer: () => void;
  handleStop: () => void;
  canSteer: boolean;
  isSteering: boolean;
  steerWarning?: string;
  lockTurnConfiguration: boolean;
  canSendCurrentAgent: boolean;
  providerDisplayName?: string;
  modelDisplayName?: string;
  modelCatalogWarning?: string;
  agentModelPresets: AgentModelPreset[];
  selectedAgentModel: string;
  handleAgentModelSelect: (modelId: string) => void;
  cattyConfiguredProviders: ProviderConfig[];
  effectiveActiveProvider?: ProviderConfig;
  effectiveActiveModelId?: string;
  handleAgentProviderModelSelect: (providerId: string, modelId: string, contextWindow?: number) => void;
  selectedCattyThinking?: string;
  handleCattyThinkingSelect?: (level: string) => void;
  files: UploadedFile[];
  addFiles: (inputFiles: File[]) => Promise<void>;
  removeFile: (fileId: string) => void;
  terminalSessions: TerminalSessionSummary[];
  selectedUserSkills: UserSkillOption[];
  userSkillOptions: UserSkillOption[];
  quickMessages: AIQuickMessage[];
  addSelectedUserSkill: (slug: string) => void;
  removeSelectedUserSkill: (slug: string) => void;
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode?: (mode: AIPermissionMode) => void;
  notes?: VaultNote[];
  hosts?: Host[];
  onOpenVaultNote?: (noteId: string) => void;
  onOpenVaultHost?: (hostId: string) => void;
  onOpenVaultSection?: (section: 'notes' | 'hosts') => void;
  /** Hidden retained panels keep the composer warm without the message tree. */
  parked?: boolean;
  /** Disable header transitions while send preflight is in flight. */
  sending?: boolean;
}

export const AIChatPanelContent: React.FC<AIChatPanelContentProps> = ({
  t,
  currentAgentId,
  externalAgents,
  discoveredAgents,
  isDiscovering,
  handleAgentChange,
  handleEnableDiscoveredAgent,
  rediscover,
  handleOpenSettings,
  activeSession,
  handleExport,
  showHistory,
  setShowHistory,
  handleNewChat,
  historySessions,
  activeSessionId,
  handleSelectSession,
  handleDeleteSession,
  messages,
  isStreaming,
  activeCompaction = null,
  contextUsage = null,
  inputValue,
  setInputValue,
  handleSend,
  handleCompact,
  canCompact = false,
  handleSteer,
  handleStop,
  canSteer,
  isSteering,
  steerWarning,
  lockTurnConfiguration,
  canSendCurrentAgent,
  providerDisplayName,
  modelDisplayName,
  modelCatalogWarning,
  agentModelPresets,
  selectedAgentModel,
  handleAgentModelSelect,
  cattyConfiguredProviders,
  effectiveActiveProvider,
  effectiveActiveModelId,
  handleAgentProviderModelSelect,
  selectedCattyThinking,
  handleCattyThinkingSelect,
  files,
  addFiles,
  removeFile,
  terminalSessions,
  selectedUserSkills,
  userSkillOptions,
  quickMessages,
  addSelectedUserSkill,
  removeSelectedUserSkill,
  globalPermissionMode,
  setGlobalPermissionMode,
  notes = [],
  hosts = [],
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSection,
  parked = false,
  sending = false,
}) => {
  const mentionHosts = React.useMemo(
    () => terminalSessions.map((session) => ({
      sessionId: session.sessionId,
      hostname: session.hostname,
      label: session.label,
      connected: session.connected,
    })),
    [terminalSessions],
  );
  const providerSwitcher = React.useMemo(
    () => (
      currentAgentId === 'catty' && cattyConfiguredProviders.length > 0
        ? {
            providers: cattyConfiguredProviders,
            selectedProviderId: effectiveActiveProvider?.id,
            selectedModelId: effectiveActiveModelId || undefined,
            onSelect: handleAgentProviderModelSelect,
          }
        : undefined
    ),
    [
      cattyConfiguredProviders,
      currentAgentId,
      effectiveActiveModelId,
      effectiveActiveProvider?.id,
      handleAgentProviderModelSelect,
    ],
  );
  const hiddenParts = getAIPanelDiagnosticHiddenParts();
  const hideHeader = isAIPanelDiagnosticPartHidden('header', hiddenParts);
  const hideHistory = isAIPanelDiagnosticPartHidden('history', hiddenParts);
  const hideMessages = isAIPanelDiagnosticPartHidden('messages', hiddenParts);
  const hideRecent = isAIPanelDiagnosticPartHidden('recent', hiddenParts);
  const hideInput = isAIPanelDiagnosticPartHidden('input', hiddenParts);

  return (
    <div className="flex flex-col h-full bg-background" data-section="ai-chat-panel">
      {/* ── Header ── */}
      {!hideHeader && (
        <React.Profiler {...getAIPanelProfilerProps('AIChatPanel.Header')}>
          <div className={cn(
            TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS,
            'px-2 flex items-center justify-between border-b border-border/50',
          )}>
            <AgentSelector
              currentAgentId={currentAgentId}
              externalAgents={externalAgents}
              discoveredAgents={discoveredAgents}
              isDiscovering={isDiscovering}
              parked={parked}
              disabled={sending}
              onSelectAgent={handleAgentChange}
              onEnableDiscoveredAgent={handleEnableDiscoveredAgent}
              onRediscover={rediscover}
              onManageAgents={handleOpenSettings}
            />
            <div className="flex items-center gap-0.5">
              <ConversationExport
                session={activeSession}
                onExport={handleExport}
                className="h-6 w-6 rounded-md text-muted-foreground/62 hover:bg-white/[0.05] hover:text-foreground [&_svg]:size-3"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-md text-muted-foreground/62 hover:bg-white/[0.05] hover:text-foreground"
                    disabled={sending}
                    onClick={() => setShowHistory(!showHistory)}
                  >
                    <History size={12} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('ai.chat.sessionHistory')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-md text-primary/82 hover:bg-primary/[0.10] hover:text-primary"
                    disabled={sending}
                    onClick={handleNewChat}
                  >
                    <Plus size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('ai.chat.newChat')}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </React.Profiler>
      )}

      {/* ── Main content ── */}
      {!parked && showHistory && !hideHistory ? (
        <React.Profiler {...getAIPanelProfilerProps('AIChatPanel.History')}>
          <SessionHistoryDrawer
            sessions={historySessions}
            activeSessionId={activeSessionId}
            onSelect={sending ? () => undefined : handleSelectSession}
            onDelete={handleDeleteSession}
            onClose={() => setShowHistory(false)}
          />
        </React.Profiler>
      ) : (
        <>
          {/* Chat messages */}
          {!parked && !hideMessages && (
            <React.Profiler {...getAIPanelProfilerProps('AIChatPanel.Messages')}>
              <ChatMessageList
                messages={messages}
                isStreaming={isStreaming}
                activeSessionId={activeSessionId}
                activeCompaction={activeCompaction}
                notes={notes}
                hosts={hosts}
                onOpenVaultNote={onOpenVaultNote}
                onOpenVaultHost={onOpenVaultHost}
                onOpenVaultSection={onOpenVaultSection}
              />
            </React.Profiler>
          )}

          {/* Recent sessions (Zed-style, shown when no messages) */}
          {!parked && messages.length === 0 && historySessions.length > 0 && !hideRecent && (
            <React.Profiler {...getAIPanelProfilerProps('AIChatPanel.Recent')}>
              <div className="shrink-0 px-4 pb-1">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-[11px] text-muted-foreground/30 tracking-wide">{t('ai.chat.recent')}</span>
                  <button
                    onClick={() => setShowHistory(true)}
                    className="text-[11px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors cursor-pointer"
                  >
                    {t('ai.chat.viewAll')}
                  </button>
                </div>
                {historySessions.slice(0, 3).map((session) => (
                  <button
                    key={session.id}
                    disabled={sending}
                    onClick={() => handleSelectSession(session.id)}
                    className="w-full flex items-baseline justify-between py-1.5 text-left hover:text-foreground transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="text-[13px] text-foreground/60 truncate pr-4">
                      {session.title || t('ai.chat.untitled')}
                    </span>
                    <span className="text-[11px] text-muted-foreground/25 shrink-0">
                      {formatRelativeTime(new Date(session.updatedAt), t)}
                    </span>
                  </button>
                ))}
              </div>
            </React.Profiler>
          )}

          {/* Input area */}
          {!hideInput && (
            <React.Profiler {...getAIPanelProfilerProps('AIChatPanel.Input')}>
              <div>
                {steerWarning ? (
                  <div role="status" className="mx-3 mb-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-600 dark:text-amber-400">
                    {steerWarning}
                  </div>
                ) : modelCatalogWarning ? (
                  <div role="status" className="mx-3 mb-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-600 dark:text-amber-400">
                    {modelCatalogWarning}
                  </div>
                ) : null}
                <ChatInput
                  parked={parked}
                  value={inputValue}
                  onChange={setInputValue}
                  onSend={handleSend}
                  onCompact={handleCompact}
                  canCompact={canCompact}
                  onSteer={handleSteer}
                  onStop={handleStop}
                  isStreaming={isStreaming}
                  canSteer={canSteer}
                  isSteering={isSteering}
                  lockTurnConfiguration={lockTurnConfiguration}
                  disabled={!canSendCurrentAgent}
                  providerName={providerDisplayName}
                  modelName={modelDisplayName}
                  agentName={currentAgentId === 'catty' ? 'Catty Agent' : externalAgents.find(a => a.id === currentAgentId)?.name}
                  modelPresets={agentModelPresets}
                  selectedModelId={selectedAgentModel}
                  onModelSelect={handleAgentModelSelect}
                  providerSwitcher={providerSwitcher}
                  pickerScope={currentAgentId}
                  thinkingLevel={currentAgentId === 'catty' ? selectedCattyThinking : undefined}
                  onThinkingLevelChange={currentAgentId === 'catty' ? handleCattyThinkingSelect : undefined}
                  files={files}
                  onAddFiles={addFiles}
                  onRemoveFile={removeFile}
                  hosts={mentionHosts}
                  selectedUserSkills={selectedUserSkills}
                  userSkills={userSkillOptions}
                  quickMessages={quickMessages}
                  onAddUserSkill={addSelectedUserSkill}
                  onRemoveUserSkill={removeSelectedUserSkill}
                  permissionMode={globalPermissionMode}
                  onPermissionModeChange={setGlobalPermissionMode}
                  contextUsage={contextUsage}
                />
              </div>
            </React.Profiler>
          )}
        </>
      )}

    </div>
  );
};
