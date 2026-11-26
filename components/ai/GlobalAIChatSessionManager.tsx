import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FolderInput, MoreHorizontal, Pencil, Search, Trash2, X } from 'lucide-react';
import type { AISession, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Dropdown, DropdownContent, DropdownTrigger } from '../ui/dropdown';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { SESSION_HISTORY_ROW_CLASSNAMES } from './sessionHistoryLayout';
import { formatRelativeTime } from '../AIChatSessionHistoryDrawer';
import {
  buildGlobalManagerRows,
  collectGlobalManagerAgentIds,
  filterGlobalManagerRows,
  type GlobalManagerHostInfo,
  type GlobalManagerScopeTarget,
  type GlobalManagerTerminalInfo,
} from './globalSessionManagerRows';

// -------------------------------------------------------------------
// Global AI Session Manager
// -------------------------------------------------------------------
// Scope-agnostic view over all saved AI chats. Clicking any chat opens
// it directly in the viewing panel (automatically attaching past chats
// to the current panel). Secondary management actions (rename, export,
// move to another open terminal/workspace, confirm-gated delete) live
// inside a single overflow menu so rows stay calm and scannable.
// -------------------------------------------------------------------

interface GlobalAIChatSessionManagerProps {
  sessions: AISession[];
  activeSessionIdMap: Readonly<Record<string, string | null>>;
  currentScopeType: 'terminal' | 'workspace';
  currentScopeTargetId?: string;
  /**
   * Host ids of the viewing panel's own scope; carried onto chats moved to
   * "This panel" so the destination's host association survives.
   */
  currentScopeHostIds?: ReadonlyArray<string>;
  workspaces: ReadonlyArray<{ id: string; title: string }>;
  terminalInfos: ReadonlyArray<GlobalManagerTerminalInfo>;
  hosts?: ReadonlyArray<GlobalManagerHostInfo>;
  externalAgents: ExternalAgentConfig[];
  rebindTargets: GlobalManagerScopeTarget[];
  onSelect: (sessionId: string) => void;
  /** Focus an already-open terminal or workspace hosting an active chat instead of moving it. */
  onFocusScope?: (target: { type: 'terminal' | 'workspace'; targetId: string }) => boolean | void;
  onRebind: (sessionId: string, target: GlobalManagerScopeTarget) => void;
  onRename?: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
}

const MANAGER_RENDER_BATCH = 80;
const MANAGER_RENDER_STEP = 60;

export const GlobalAIChatSessionManager: React.FC<GlobalAIChatSessionManagerProps> = ({
  sessions,
  activeSessionIdMap,
  currentScopeType,
  currentScopeTargetId,
  currentScopeHostIds,
  workspaces,
  terminalInfos,
  hosts,
  externalAgents,
  rebindTargets,
  onSelect,
  onFocusScope,
  onRebind,
  onRename,
  onDelete,
  onExport,
}) => {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [renderCount, setRenderCount] = useState(MANAGER_RENDER_BATCH);
  const [deleteTarget, setDeleteTarget] = useState<AISession | null>(null);
  const [moveSession, setMoveSession] = useState<AISession | null>(null);
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () => buildGlobalManagerRows({
      sessions,
      activeSessionIdMap,
      currentScopeType,
      currentScopeTargetId,
      workspaces,
      terminalInfos,
      hosts,
      externalAgents,
      t,
    }),
    [sessions, activeSessionIdMap, currentScopeType, currentScopeTargetId, workspaces, terminalInfos, hosts, externalAgents, t],
  );
  const agentIds = useMemo(() => collectGlobalManagerAgentIds(rows), [rows]);
  const showAgentMeta = agentIds.length > 1;
  const effectiveAgentFilter = agentFilter !== 'all' && agentIds.includes(agentFilter)
    ? agentFilter
    : 'all';
  const filteredRows = useMemo(
    () => filterGlobalManagerRows(rows, { query: searchQuery, agentId: effectiveAgentFilter }),
    [rows, searchQuery, effectiveAgentFilter],
  );

  useEffect(() => {
    setRenderCount(MANAGER_RENDER_BATCH);
  }, [searchQuery, agentFilter]);

  useEffect(() => {
    if (agentFilter !== 'all' && !agentIds.includes(agentFilter)) {
      setAgentFilter('all');
    }
  }, [agentFilter, agentIds]);

  useEffect(() => {
    if (renamingSessionId) renameInputRef.current?.focus();
  }, [renamingSessionId]);

  const displayedRows = filteredRows.slice(0, renderCount);
  const hiddenRowCount = Math.max(0, filteredRows.length - renderCount);

  const commitDelete = () => {
    if (!deleteTarget) return;
    onDelete(deleteTarget.id);
    setDeleteTarget(null);
  };

  const beginRename = (session: AISession) => {
    setOpenMenuSessionId(null);
    setRenamingSessionId(session.id);
    setRenameDraft(session.title || '');
  };

  const commitRename = () => {
    if (renamingSessionId && renameDraft.trim()) {
      onRename?.(renamingSessionId, renameDraft.trim());
    }
    setRenamingSessionId(null);
    setRenameDraft('');
  };

  const getOtherMoveTargets = (session: AISession) =>
    rebindTargets.filter(
      (target) =>
        session.scopeDangling
        || target.type !== session.scope.type
        || target.targetId !== session.scope.targetId,
    );

  const chooseMoveTarget = (value: string) => {
    if (!moveSession || !value) return;
    if (value === 'here') {
      if (!currentScopeTargetId) return;
      onRebind(moveSession.id, {
        type: currentScopeType,
        targetId: currentScopeTargetId,
        label: '',
        hostIds: currentScopeHostIds && currentScopeHostIds.length > 0
          ? [...currentScopeHostIds]
          : undefined,
      });
    } else {
      const target = rebindTargets.find((candidate) => `${candidate.type}:${candidate.targetId}` === value);
      if (target) onRebind(moveSession.id, target);
    }
    setMoveSession(null);
  };

  const activateRow = (row: ReturnType<typeof buildGlobalManagerRows>[number]) => {
    if (row.isActiveElsewhere && row.activeElsewhereTarget && onFocusScope) {
      const focused = onFocusScope(row.activeElsewhereTarget);
      if (focused !== false) return;
    }
    onSelect(row.session.id);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" data-section="ai-global-session-manager">
      <div className="px-3 py-2 shrink-0 border-b border-border/30 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
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
        {showAgentMeta && (
          <Select value={effectiveAgentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger
              aria-label={t('ai.chat.managerFilterAllAgents')}
              className="h-8 w-auto max-w-[120px] shrink-0 px-2 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-[12px]">
                {t('ai.chat.managerFilterAllAgents')}
              </SelectItem>
              {agentIds.map((agentId) => (
                <SelectItem key={agentId} value={agentId} className="text-[12px]">
                  {rows.find((row) => row.agentId === agentId)?.agentLabel ?? agentId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
              {displayedRows.map((row) => {
                const otherMoveTargets = getOtherMoveTargets(row.session);
                const canMoveElsewhere = otherMoveTargets.length > 0;
                const isRenaming = renamingSessionId === row.session.id;
                const isMenuOpen = openMenuSessionId === row.session.id;
                const subtitleParts: string[] = [];
                if (row.scopeLabel) subtitleParts.push(row.scopeLabel);
                if (showAgentMeta) subtitleParts.push(row.agentLabel);
                if (row.messageCount > 0) {
                  subtitleParts.push(
                    t('ai.chat.managerMessagesCount').replace('{n}', String(row.messageCount)),
                  );
                }

                return (
                  <React.Fragment key={row.session.id}>
                    <div
                      role="button"
                      tabIndex={row.canActivate ? 0 : -1}
                      onClick={() => {
                        if (!isRenaming && row.canActivate) activateRow(row);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (!isRenaming && row.canActivate && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          activateRow(row);
                        }
                      }}
                      className={cn(
                        SESSION_HISTORY_ROW_CLASSNAMES.row,
                        row.isCurrentActive
                          ? 'text-foreground'
                          : 'text-foreground/75 hover:text-foreground',
                        !row.canActivate && 'cursor-default',
                      )}
                      data-session-id={row.session.id}
                      data-scope-state={row.scopeState}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {row.isCurrentActive && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                              aria-hidden
                            />
                          )}
                          <span className={cn(SESSION_HISTORY_ROW_CLASSNAMES.title, 'shrink')}>
                            {isRenaming ? (
                              <Input
                                ref={renameInputRef}
                                type="text"
                                value={renameDraft}
                                aria-label={t('ai.chat.renameChat')}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    commitRename();
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setRenamingSessionId(null);
                                    setRenameDraft('');
                                  }
                                }}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onBlur={commitRename}
                                className="h-6 text-[12px]"
                              />
                            ) : (
                              row.title
                            )}
                          </span>
                          {row.isActiveElsewhere && (
                            <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground/75">
                              {t('ai.chat.managerBadgeActive')}
                            </span>
                          )}
                        </div>
                        {subtitleParts.length > 0 && (
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/50 min-w-0">
                            {subtitleParts.map((part, index) => (
                              <React.Fragment key={`${row.session.id}-meta-${index}`}>
                                {index > 0 && <span aria-hidden>·</span>}
                                <span className={index === 0 ? 'truncate' : 'shrink-0'}>
                                  {part}
                                </span>
                              </React.Fragment>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className={SESSION_HISTORY_ROW_CLASSNAMES.meta}>
                        <span className={SESSION_HISTORY_ROW_CLASSNAMES.time}>
                          {formatRelativeTime(new Date(row.session.updatedAt), t)}
                        </span>
                        <Dropdown
                          open={isMenuOpen}
                          onOpenChange={(open) => setOpenMenuSessionId(open ? row.session.id : null)}
                        >
                          <DropdownTrigger asChild>
                            <button
                              type="button"
                              aria-label={t('ai.chat.managerMoreActions')}
                              onClick={(e) => e.stopPropagation()}
                              className={cn(
                                'p-0.5 text-muted-foreground/60 hover:text-foreground transition-all cursor-pointer shrink-0',
                                isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                              )}
                            >
                              <MoreHorizontal size={13} />
                            </button>
                          </DropdownTrigger>
                          <DropdownContent
                            align="end"
                            className="min-w-[144px] p-1"
                            keyboardNavigation
                          >
                            {onRename && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  beginRename(row.session);
                                }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/85 hover:bg-muted cursor-pointer"
                              >
                                <Pencil size={12} className="shrink-0 text-muted-foreground" />
                                <span>{t('ai.chat.renameChat')}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuSessionId(null);
                                onExport(row.session.id);
                              }}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/85 hover:bg-muted cursor-pointer"
                            >
                              <Download size={12} className="shrink-0 text-muted-foreground" />
                              <span>{t('ai.chat.managerExportOne')}</span>
                            </button>
                            {canMoveElsewhere && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenuSessionId(null);
                                  setMoveSession(
                                    moveSession?.id === row.session.id ? null : row.session,
                                  );
                                }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/85 hover:bg-muted cursor-pointer"
                              >
                                <FolderInput size={12} className="shrink-0 text-muted-foreground" />
                                <span>{t('ai.chat.managerRebind')}</span>
                              </button>
                            )}
                            <div className="my-1 h-px bg-border/50" />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuSessionId(null);
                                setDeleteTarget(row.session);
                              }}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-destructive hover:bg-destructive/10 cursor-pointer"
                            >
                              <Trash2 size={12} className="shrink-0" />
                              <span>{t('common.delete')}</span>
                            </button>
                          </DropdownContent>
                        </Dropdown>
                      </div>
                    </div>
                    {moveSession?.id === row.session.id && (
                      <div className="py-1.5 pl-1 border-b border-border/20" data-section="ai-manager-rebind-picker">
                        <Select value="" onValueChange={chooseMoveTarget}>
                          <SelectTrigger
                            aria-label={t('ai.chat.managerRebindPick')}
                            className="h-7 w-full px-2 text-[12px]"
                          >
                            <SelectValue placeholder={t('ai.chat.managerRebindPick')} />
                          </SelectTrigger>
                          <SelectContent>
                            {currentScopeTargetId
                              && (
                                row.session.scopeDangling
                                || row.session.scope.type !== currentScopeType
                                || row.session.scope.targetId !== currentScopeTargetId
                              ) && (
                              <SelectItem value="here" className="text-[12px]">
                                {t('ai.chat.managerRebindHere')}
                              </SelectItem>
                            )}
                            {otherMoveTargets.map((target) => (
                              <SelectItem
                                key={`${target.type}:${target.targetId}`}
                                value={`${target.type}:${target.targetId}`}
                                className="text-[12px]"
                              >
                                {target.type === 'workspace'
                                  ? `${t('ai.chat.chatsScopeWorkspace')}: ${target.label}`
                                  : `${t('ai.chat.chatsScopeTerminal')}: ${target.label}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
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
