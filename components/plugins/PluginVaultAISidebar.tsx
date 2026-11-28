import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAIState } from '../../application/state/useAIState';
import { useAISessionsStore } from '../../application/state/aiSessionsStore';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { AISession } from '../../infrastructure/ai/types';
import type {
  PluginAISidebarPrompt,
  PluginAISidebarTurnContext,
} from '../../infrastructure/ai/pluginAiSidebarTypes';
import {
  MAX_PLUGIN_AI_SIDEBAR_WIDTH,
  MIN_PLUGIN_AI_SIDEBAR_WIDTH,
  readPluginAiSidebarWidth,
  writePluginAiSidebarWidth,
  type PendingPluginSidebarPrompt,
} from '../../application/state/usePluginAiSidebar';
import { LazyLoadBoundary } from '../ui/lazy-load-boundary';
import { cn } from '../../lib/utils';

const LazyAIChatSidePanel = lazy(() => import('../AIChatSidePanel'));

const PluginAISidebarFallback: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        {t('ai.chat.preparing')}
      </div>
    </div>
  );
};

export interface PluginVaultAISidebarProps {
  pluginId: string;
  pluginName: string;
  viewId: string;
  open: boolean;
  onClose: () => void;
  pluginContext: PluginAISidebarTurnContext | null;
  suggestedPrompts?: readonly PluginAISidebarPrompt[];
  pendingPrompt?: PendingPluginSidebarPrompt | null;
  onPendingPromptConsumed?: (id: number) => void;
}

export const PluginVaultAISidebar: React.FC<PluginVaultAISidebarProps> = ({
  pluginName,
  viewId,
  open,
  onClose,
  pluginContext,
  suggestedPrompts,
  pendingPrompt,
  onPendingPromptConsumed,
}) => {
  const aiConfig = useAIState();
  const {
    sessions,
    activeSessionIdMap,
    draftsByScope,
    panelViewByScope,
  } = useAISessionsStore();
  const [width, setWidth] = useState<number>(readPluginAiSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      const next = Math.max(
        MIN_PLUGIN_AI_SIDEBAR_WIDTH,
        Math.min(MAX_PLUGIN_AI_SIDEBAR_WIDTH, Math.round(window.innerWidth - event.clientX - 8)),
      );
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = '';
      writePluginAiSidebarWidth(widthRef.current);
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [resizing]);

  const handleStartResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setResizing(true);
  }, []);

  const scopeTargetId = `plugin-view:${viewId}`;

  return (
    <aside
      data-plugin-ai-sidebar={viewId}
      data-open={open ? 'true' : 'false'}
      aria-label={`${pluginName} AI Assistant`}
      style={open ? { width } : undefined}
      className={cn(
        'relative flex h-full min-h-0 shrink-0 flex-col bg-background',
        open ? 'border-l border-border/35' : 'hidden',
      )}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize AI sidebar"
          onPointerDown={handleStartResize}
          className={cn(
            'absolute top-0 bottom-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize transition-colors',
            resizing ? 'bg-primary/40' : 'hover:bg-primary/25',
          )}
        />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <LazyLoadBoundary name="Plugin AI sidebar" resetKey={viewId}>
          <Suspense fallback={<PluginAISidebarFallback />}>
            <LazyAIChatSidePanel
              sessions={sessions as AISession[]}
              activeSessionIdMap={activeSessionIdMap as Record<string, string | null>}
              draftsByScope={draftsByScope}
              panelViewByScope={panelViewByScope}
              setActiveSessionId={aiConfig.setActiveSessionId}
              ensureDraftForScope={aiConfig.ensureDraftForScope}
              updateDraft={aiConfig.updateDraft}
              showDraftView={aiConfig.showDraftView}
              showSessionView={aiConfig.showSessionView}
              clearDraftForScope={aiConfig.clearDraftForScope}
              addDraftFiles={aiConfig.addDraftFiles}
              removeDraftFile={aiConfig.removeDraftFile}
              createSession={aiConfig.createSession}
              undoLastTurnInSession={aiConfig.undoLastTurnInSession}
              deleteSession={aiConfig.deleteSession}
              updateSessionTitle={aiConfig.updateSessionTitle}
              exportSessionsBackup={aiConfig.exportSessionsBackup}
              importSessionsBackup={aiConfig.importSessionsBackup}
              updateSessionExternalSessionId={aiConfig.updateSessionExternalSessionId}
              addMessageToSession={aiConfig.addMessageToSession}
              updateLastMessage={aiConfig.updateLastMessage}
              updateMessageById={aiConfig.updateMessageById}
              persistContextCompaction={aiConfig.persistContextCompaction}
              forkSessionFromMessage={aiConfig.forkSessionFromMessage}
              providers={aiConfig.providers}
              activeProviderId={aiConfig.activeProviderId}
              activeModelId={aiConfig.activeModelId}
              defaultAgentId="catty"
              toolIntegrationMode={aiConfig.toolIntegrationMode}
              externalAgents={aiConfig.externalAgents}
              setExternalAgents={aiConfig.setExternalAgents}
              agentModelMap={aiConfig.agentModelMap}
              setAgentModel={aiConfig.setAgentModel}
              agentProviderMap={aiConfig.agentProviderMap}
              setAgentProvider={aiConfig.setAgentProvider}
              agentThinkingMap={aiConfig.agentThinkingMap}
              setAgentThinking={aiConfig.setAgentThinking}
              updateProvider={aiConfig.updateProvider}
              globalPermissionMode={aiConfig.globalPermissionMode}
              setGlobalPermissionMode={aiConfig.setGlobalPermissionMode}
              commandBlocklist={aiConfig.commandBlocklist}
              commandTimeout={aiConfig.commandTimeout}
              responseIdleTimeout={aiConfig.responseIdleTimeout}
              maxIterations={aiConfig.maxIterations}
              toolOutputMaxChars={aiConfig.toolOutputMaxChars}
              webSearchConfig={aiConfig.webSearchConfig}
              quickMessages={aiConfig.quickMessages}
              scopeType="global"
              scopeTargetId={scopeTargetId}
              scopeLabel={pluginContext?.title || pluginName}
              terminalSessions={[]}
              isVisible={open}
              pluginContext={pluginContext}
              pluginSuggestedPrompts={suggestedPrompts}
              pendingPluginPrompt={pendingPrompt}
              onPendingPluginPromptConsumed={onPendingPromptConsumed}
              onClosePanel={onClose}
              borderlessChrome
            />
          </Suspense>
        </LazyLoadBoundary>
      </div>
    </aside>
  );
};
