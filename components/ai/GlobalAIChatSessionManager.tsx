import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderInput, Play, Search, Trash2, X } from 'lucide-react';
import type { AISession, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { SESSION_HISTORY_ROW_CLASSNAMES } from './sessionHistoryLayout';
import { formatRelativeTime } from '../AIChatSessionHistoryDrawer';
import {
  buildGlobalManagerRows,
  collectGlobalManagerAgentIds,
  filterGlobalManagerRows,
  type GlobalManagerScopeTarget,
  type GlobalManagerTerminalInfo,
} from './globalSessionManagerRows';

// -------------------------------------------------------------------
// Global AI Session Manager (issue #4098 phases 4-5)
// -------------------------------------------------------------------
// A scope-agnostic view over every AI chat in the store with per-chat
// actions: open/switch (current scope only), rebind (dangling → here, or
// to any open workspace/terminal), per-chat export, and confirm-gated
// delete. Deliberately NOT part of this surface: cleanup/eviction semantics
// (#4015 R2) and cross-scope activation.
// -------------------------------------------------------------------

interface GlobalAIChatSessionManagerProps {
  sessions: AISession[];
  activeSessionIdMap: Readonly<Record<string, string | null>>;
  currentScopeType: 'terminal' | 'workspace';
  currentScopeTargetId?: string;
  workspaces: ReadonlyArray<{ id: string; title: string }>;
  terminalInfos: ReadonlyArray<GlobalManagerTerminalInfo>;
  externalAgents: ExternalAgentConfig[];
  rebindTargets: GlobalManagerScopeTarget[];
  onSelect: (sessionId: string) => void;
  onRebind: (sessionId: string, target: GlobalManagerScopeTarget) => void;
  onDelete: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
}

// Render guard, mirroring the scoped drawer. The store is capped well below
// this by retention (MAX_STORED_SESSIONS), but the manager must stay cheap
// even on stores grown before the cap existed (~2k sessions).
const MANAGER_RENDER_BATCH = 80;
const MANAGER_RENDER_STEP = 60;

export const GlobalAIChatSessionManager: React.FC<GlobalAIChatSessionManagerProps> = ({
  sessions,
  activeSessionIdMap,
  currentScopeType,
  currentScopeTargetId,
  workspaces,
  terminalInfos,
  externalAgents,
  rebindTargets,
  onSelect,
  onRebind,
  onDelete,
  onExport,
}) => {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [renderCount, setRenderCount] = useState(MANAGER_RENDER_BATCH);
  const [deleteTarget, setDeleteTarget] = useState<AISession | null>(null);
  const [rebindSession, setRebindSession] = useState<AISession | null>(null);

  const rows = useMemo(
    () => buildGlobalManagerRows({
      sessions,
      activeSessionIdMap,
      currentScopeType,
      currentScopeTargetId,
      workspaces,
      terminalInfos,
      externalAgents,
      t,
    }),
    [sessions, activeSessionIdMap, currentScopeType, currentScopeTargetId, workspaces, terminalInfos, externalAgents, t],
  );
  const agentIds = useMemo(() => collectGlobalManagerAgentIds(rows), [rows]);
  const filteredRows = useMemo(
    () => filterGlobalManagerRows(rows, { query: searchQuery, agentId: agentFilter }),
    [rows, searchQuery, agentFilter],
  );

  useEffect(() => {
    setRenderCount(MANAGER_RENDER_BATCH);
  }, [searchQuery, agentFilter]);

  const displayedRows = filteredRows.slice(0, renderCount);
  const hiddenRowCount = Math.max(0, filteredRows.length - renderCount);

  const commitDelete = () => {
    if (!deleteTarget) return;
    onDelete(deleteTarget.id);
    setDeleteTarget(null);
  };

  const chooseRebindTarget = (value: string) => {
    if (!rebindSession || !value) return;
    if (value === 'here') {
      if (!currentScopeTargetId) return;
      onRebind(rebindSession.id, { type: currentScopeType, targetId: currentScopeTargetId, label: '' });
    } else {
      const target = rebindTargets.find((candidate) => `${candidate.type}:${candidate.targetId}` === value);
      if (target) onRebind(rebindSession.id, target);
    }
    setRebindSession(null);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" data-section="ai-global-session-manager">
      <div className="px-3 py-2 shrink-0 border-b border-border/30 space-y-2">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none"
          />
          <Input
            type="text"
            value={searchQuery}
            maxLength={200}
            placeholder={t('ai.chat.managerSearchPlaceholder')}
            aria-label={t('ai.chat.managerSearchPlaceholder')}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="h-8 pl-8 pr-7 text-[12px]"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label={t('ai.chat.clearSessionSearch')}
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {agentIds.length > 1 && (
          <select
            value={agentFilter}
            aria-label={t('ai.chat.managerFilterAllAgents')}
            onChange={(event) => setAgentFilter(event.target.value)}
            className="h-7 w-full rounded-md border border-input bg-background px-2 text-[12px] text-foreground focus:outline-none cursor-pointer"
          >
            <option value="all">{t('ai.chat.managerFilterAllAgents')}</option>
            {agentIds.map((agentId) => (
              <option key={agentId} value={agentId}>
                {rows.find((row) => row.agentId === agentId)?.agentLabel ?? agentId}
              </option>
            ))}
          </select>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3">
          {filteredRows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                {rows.length === 0 ? t('ai.chat.noSessions') : t('ai.chat.noMatchingSessions')}
              </p>
            </div>
          ) : (
            <>
              {hiddenRowCount > 0 && (
                <button
                  type="button"
                  onClick={() => setRenderCount((count) => count + MANAGER_RENDER_STEP)}
                  className="w-full py-2 text-center text-[12px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
                >
                  {t('ai.chat.loadMoreSessions').replace('{n}', String(hiddenRowCount))}
                </button>
              )}
              {displayedRows.map((row) => (
                <React.Fragment key={row.session.id}>
                  <div
                    className={cn(SESSION_HISTORY_ROW_CLASSNAMES.row, 'cursor-default')}
                    data-session-id={row.session.id}
                    data-scope-state={row.scopeState}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={cn(SESSION_HISTORY_ROW_CLASSNAMES.title, 'shrink')}>
                          {row.title}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1 text-[10px] leading-4',
                            row.scopeState === 'dangling'
                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                              : row.scopeState === 'active'
                                ? 'bg-primary/15 text-primary'
                                : 'bg-muted text-muted-foreground/70',
                          )}
                        >
                          {t(row.scopeState === 'dangling'
                            ? 'ai.chat.chatsScopeDangling'
                            : row.scopeState === 'active'
                              ? 'ai.chat.managerBadgeActive'
                              : 'ai.chat.managerBadgeIdle')}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/50 min-w-0">
                        <span className="truncate">{row.agentLabel}</span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{row.scopeLabel}</span>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">
                          {t('ai.chat.managerMessagesCount').replace('{n}', String(row.messageCount))}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">{formatRelativeTime(new Date(row.session.updatedAt), t)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {row.canActivate ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => onSelect(row.session.id)}
                              aria-label={t('ai.chat.managerOpen')}
                              className={SESSION_HISTORY_ROW_CLASSNAMES.deleteButton}
                            >
                              <Play size={12} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{t('ai.chat.managerOpen')}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              disabled
                              aria-disabled="true"
                              aria-label={t('ai.chat.managerOpenDisabled')}
                              className={cn(SESSION_HISTORY_ROW_CLASSNAMES.deleteButton, 'opacity-30 cursor-not-allowed')}
                            >
                              <Play size={12} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{t('ai.chat.managerOpenDisabled')}</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onExport(row.session.id)}
                            aria-label={t('ai.chat.managerExportOne')}
                            className={SESSION_HISTORY_ROW_CLASSNAMES.deleteButton}
                          >
                            <Download size={12} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t('ai.chat.managerExportOne')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setRebindSession(
                              rebindSession?.id === row.session.id ? null : row.session,
                            )}
                            aria-label={t('ai.chat.managerRebind')}
                            className={SESSION_HISTORY_ROW_CLASSNAMES.deleteButton}
                          >
                            <FolderInput size={12} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t('ai.chat.managerRebind')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setDeleteTarget(row.session)}
                            aria-label={t('common.delete')}
                            className={SESSION_HISTORY_ROW_CLASSNAMES.deleteButton}
                          >
                            <Trash2 size={12} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t('common.delete')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  {rebindSession?.id === row.session.id && (
                    <div className="py-1.5 pl-1 border-b border-border/20" data-section="ai-manager-rebind-picker">
                      <select
                        value=""
                        aria-label={t('ai.chat.managerRebindPick')}
                        onChange={(event) => chooseRebindTarget(event.target.value)}
                        className="h-7 w-full rounded-md border border-input bg-background px-2 text-[12px] text-foreground focus:outline-none cursor-pointer"
                      >
                        <option value="">{t('ai.chat.managerRebindPick')}</option>
                        {currentScopeTargetId
                          && (
                            row.session.scopeDangling
                            || row.session.scope.type !== currentScopeType
                            || row.session.scope.targetId !== currentScopeTargetId
                          ) && (
                          <option value="here">{t('ai.chat.managerRebindHere')}</option>
                        )}
                        {rebindTargets.map((target) => (
                          <option
                            key={`${target.type}:${target.targetId}`}
                            value={`${target.type}:${target.targetId}`}
                          >
                            {target.type === 'workspace'
                              ? `${t('ai.chat.chatsScopeWorkspace')}: ${target.label}`
                              : `${t('ai.chat.chatsScopeTerminal')}: ${target.label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </React.Fragment>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <ConfirmDialog
        open={deleteTarget != null}
        title={t('ai.chat.managerDeleteTitle')}
        message={deleteTarget
          ? t('ai.chat.managerDeleteMessage').replace(
              '{title}',
              deleteTarget.title || t('ai.chat.untitled'),
            )
          : undefined}
        confirmLabel={t('common.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={commitDelete}
      />
    </div>
  );
};
