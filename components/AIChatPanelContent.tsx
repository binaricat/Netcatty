import React, { type Dispatch, type SetStateAction } from 'react';
import { History, Plus } from 'lucide-react';
import type { AIPermissionMode, AISession, ChatMessage, DiscoveredAgent, ExternalAgentConfig, AgentModelPreset, ProviderConfig, UploadedFile } from '../infrastructure/ai/types';
import type { UserSkillOption } from './ai/userSkillsState';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import AgentSelector from './ai/AgentSelector';
import ChatInput from './ai/ChatInput';
import ChatMessageList from './ai/ChatMessageList';
import ConversationExport from './ai/ConversationExport';
import { SessionHistoryDrawer, formatRelativeTime } from './AIChatSessionHistoryDrawer';

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
  inputValue: string;
  setInputValue: (value: string) => void;
  handleSend: () => void;
  handleStop: () => void;
  canSendCurrentAgent: boolean;
  providerDisplayName?: string;
  modelDisplayName?: string;
  agentModelPresets: AgentModelPreset[];
  selectedAgentModel: string;
  handleAgentModelSelect: (modelId: string) => void;
  cattyConfiguredProviders: ProviderConfig[];
  effectiveActiveProvider?: ProviderConfig;
  effectiveActiveModelId?: string;
  handleAgentProviderModelSelect: (providerId: string, modelId: string) => void;
  files: UploadedFile[];
  addFiles: (inputFiles: File[]) => Promise<void>;
  removeFile: (fileId: string) => void;
  terminalSessions: TerminalSessionSummary[];
  selectedUserSkills: UserSkillOption[];
  userSkillOptions: UserSkillOption[];
  addSelectedUserSkill: (slug: string) => void;
  removeSelectedUserSkill: (slug: string) => void;
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode?: (mode: AIPermissionMode) => void;
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
  inputValue,
  setInputValue,
  handleSend,
  handleStop,
  canSendCurrentAgent,
  providerDisplayName,
  modelDisplayName,
  agentModelPresets,
  selectedAgentModel,
  handleAgentModelSelect,
  cattyConfiguredProviders,
  effectiveActiveProvider,
  effectiveActiveModelId,
  handleAgentProviderModelSelect,
  files,
  addFiles,
  removeFile,
  terminalSessions,
  selectedUserSkills,
  userSkillOptions,
  addSelectedUserSkill,
  removeSelectedUserSkill,
  globalPermissionMode,
  setGlobalPermissionMode
}) => (
    <div className="flex flex-col h-full bg-background" data-section="ai-chat-panel">
      {/* ── Header ── */}
      <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-border/50 shrink-0">
        <AgentSelector
          currentAgentId={currentAgentId}
          externalAgents={externalAgents}
          discoveredAgents={discoveredAgents}
          isDiscovering={isDiscovering}
          onSelectAgent={handleAgentChange}
          onEnableDiscoveredAgent={handleEnableDiscoveredAgent}
          onRediscover={rediscover}
          onManageAgents={handleOpenSettings}
        />
        <div className="flex items-center gap-0.5">
          <ConversationExport
            session={activeSession}
            onExport={handleExport}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground/62 hover:bg-white/[0.05] hover:text-foreground"
                onClick={() => setShowHistory(!showHistory)}
              >
                <History size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('ai.chat.sessionHistory')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-primary/82 hover:bg-primary/[0.10] hover:text-primary"
                onClick={handleNewChat}
              >
                <Plus size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('ai.chat.newChat')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Main content ── */}
      {showHistory ? (
        <SessionHistoryDrawer
          sessions={historySessions}
          activeSessionId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <>
          {/* Chat messages */}
          <ChatMessageList
            messages={messages}
            isStreaming={isStreaming}
            activeSessionId={activeSessionId}
          />

          {/* Recent sessions (Zed-style, shown when no messages) */}
          {messages.length === 0 && historySessions.length > 0 && (
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
                  onClick={() => handleSelectSession(session.id)}
                  className="w-full flex items-baseline justify-between py-1.5 text-left hover:text-foreground transition-colors cursor-pointer"
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
          )}

          {/* Input area */}
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            disabled={!canSendCurrentAgent}
            providerName={providerDisplayName}
            modelName={modelDisplayName}
            agentName={currentAgentId === 'catty' ? 'Catty Agent' : externalAgents.find(a => a.id === currentAgentId)?.name}
            modelPresets={agentModelPresets}
            selectedModelId={selectedAgentModel}
            onModelSelect={handleAgentModelSelect}
            providerSwitcher={
              currentAgentId === 'catty' && cattyConfiguredProviders.length > 0
                ? {
                    providers: cattyConfiguredProviders,
                    selectedProviderId: effectiveActiveProvider?.id,
                    selectedModelId: effectiveActiveModelId || undefined,
                    onSelect: handleAgentProviderModelSelect,
                  }
                : undefined
            }
            files={files}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
            hosts={terminalSessions.map(s => ({ sessionId: s.sessionId, hostname: s.hostname, label: s.label, connected: s.connected }))}
            selectedUserSkills={selectedUserSkills}
            userSkills={userSkillOptions}
            onAddUserSkill={addSelectedUserSkill}
            onRemoveUserSkill={removeSelectedUserSkill}
            permissionMode={globalPermissionMode}
            onPermissionModeChange={setGlobalPermissionMode}
          />
        </>
      )}

    </div>
);
