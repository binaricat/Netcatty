import { Circle, Columns2, Plus, Search, Server } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState, type DragEvent, type MouseEvent } from 'react';

import { useStoredNumber } from '../../application/state/useStoredNumber';
import { resolveWorkspaceFocusSessionOrder } from '../../domain/workspace';
import { resolveSessionTabTitle } from '../../domain/sessionTabTitle';
import { STORAGE_KEY_WORKSPACE_FOCUS_SIDEBAR_WIDTH } from '../../infrastructure/config/storageKeys';
import { cn } from '../../lib/utils';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { SessionInlineRenameInput } from '../terminal/SessionInlineRenameInput';
import { SessionTabContextMenuContent } from '../top-tabs/SessionTabContextMenuContent';
import { Button } from '../ui/button';
import { ContextMenu, ContextMenuTrigger } from '../ui/context-menu';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface TerminalFocusSidebarProps {
  activeWorkspace: Workspace;
  focusedSessionId: string | undefined;
  onReorderWorkspaceSessions?: (workspaceId: string, draggedSessionId: string, targetSessionId: string, position: 'before' | 'after') => void;
  onRequestAddToWorkspace?: (workspaceId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onCopySession?: (sessionId: string) => void;
  onCopySessionToNewWindow?: (sessionId: string) => void;
  onDetachSessionFromWorkspace?: (sessionId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onToggleWorkspaceViewMode?: (workspaceId: string) => void;
  onSubmitSessionRename: (sessionId: string, name: string) => void;
  resolvedPreviewTheme: TerminalTheme;
  sessionHostsMap: Map<string, Host>;
  sessions: TerminalSession[];
  t: (key: string) => string;
}

type FocusSidebarTheme = {
  termBg: string;
  termFg: string;
  selectedBg: string;
  selectedHoverBg: string;
  unselectedHoverBg: string;
  unselectedFg: string;
  mutedFg: string;
  separator: string;
};

type WorkspaceFocusSessionRowProps = {
  session: TerminalSession;
  host: Host | undefined;
  isSelected: boolean;
  isRenaming: boolean;
  renameValue: string;
  onStartRename: (sessionId: string) => void;
  onSubmitRename: (name: string) => void;
  onCancelRename: () => void;
  onCloseSession: (sessionId: string) => void;
  onCopySession?: (sessionId: string) => void;
  onCopySessionToNewWindow?: (sessionId: string) => void;
  onDetachSessionFromWorkspace?: (sessionId: string) => void;
  isDragging: boolean;
  dropPosition: 'before' | 'after' | null;
  theme: FocusSidebarTheme;
  onSelect: (sessionId: string) => void;
  onDragStart: (event: DragEvent, sessionId: string) => void;
  onDragOver: (event: DragEvent, sessionId: string) => void;
  onDrop: (event: DragEvent, sessionId: string) => void;
  onDragEnd: () => void;
  t: (key: string) => string;
};

const WorkspaceFocusSessionRow = memo<WorkspaceFocusSessionRowProps>(({
  session,
  host,
  isSelected,
  isRenaming,
  renameValue,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onCloseSession,
  onCopySession,
  onCopySessionToNewWindow,
  onDetachSessionFromWorkspace,
  isDragging,
  dropPosition,
  theme,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  t,
}) => {
  const {
    termFg,
    selectedBg,
    selectedHoverBg,
    unselectedHoverBg,
    unselectedFg,
    mutedFg,
  } = theme;

  const statusColor = session.status === 'connected'
    ? 'text-emerald-500'
    : session.status === 'connecting'
      ? 'text-amber-500'
      : 'text-red-500';

  const restBg = isSelected ? selectedBg : 'transparent';
  const hoverBg = isSelected ? selectedHoverBg : unselectedHoverBg;
  const rowFg = isSelected ? termFg : unselectedFg;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-workspace-focus-session-id={session.id}
          draggable
          role="button"
          tabIndex={0}
          className={cn(
            'relative flex w-full select-none items-center justify-start gap-2 rounded-md px-2 py-1.5 text-sm font-normal outline-none transition-colors hover:text-inherit focus-visible:ring-1',
            isDragging && 'opacity-50',
          )}
          style={{
            backgroundColor: restBg,
            color: rowFg,
            boxShadow: dropPosition
              ? `inset 0 ${dropPosition === 'before' ? '2px' : '-2px'} 0 ${termFg}`
              : undefined,
          }}
          onContextMenu={() => onSelect(session.id)}
          onDragStart={(event) => onDragStart(event, session.id)}
          onDragOver={(event) => onDragOver(event, session.id)}
          onDragLeave={(event) => {
            event.stopPropagation();
          }}
          onDrop={(event) => onDrop(event, session.id)}
          onDragEnd={onDragEnd}
          onMouseEnter={(event) => {
            event.currentTarget.style.backgroundColor = hoverBg;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.backgroundColor = restBg;
          }}
          onClick={() => onSelect(session.id)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onSelect(session.id);
          }}
        >
          <div className="relative flex h-6 w-6 shrink-0 items-center justify-center self-center">
            {host ? (
              <DistroAvatar
                host={host}
                fallback={session.hostLabel}
                size="sm"
                className="!h-6 !w-6"
              />
            ) : (
              <Server size={14} style={{ color: mutedFg }} />
            )}
            <Circle
              size={5}
              className={cn('absolute bottom-0 right-0 fill-current', statusColor)}
            />
          </div>
          <div className="flex h-6 flex-1 min-w-0 flex-col justify-center self-center text-left">
            {isRenaming ? (
              <SessionInlineRenameInput
                initialName={renameValue}
                onCommit={onSubmitRename}
                onCancel={onCancelRename}
                className="h-5 text-xs leading-none"
              />
            ) : (
              <>
                <div
                  className={cn('truncate text-xs leading-none', isSelected ? 'font-semibold' : 'font-medium')}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onStartRename(session.id);
                  }}
                >
                  {resolveSessionTabTitle(session, host)}
                </div>
                <div className="mt-0.5 truncate text-[10px] leading-none" style={{ color: mutedFg }}>
                  {session.username}@{session.hostname}
                </div>
              </>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <SessionTabContextMenuContent
        sessionId={session.id}
        onCloseSession={onCloseSession}
        onCopySession={onCopySession}
        onCopySessionToNewWindow={onCopySessionToNewWindow}
        onDetachSession={onDetachSessionFromWorkspace}
        onRenameSession={onStartRename}
        t={t}
      />
    </ContextMenu>
  );
}, (prev, next) => (
  prev.session === next.session
  && prev.host === next.host
  && prev.isSelected === next.isSelected
  && prev.isRenaming === next.isRenaming
  && prev.renameValue === next.renameValue
  && prev.isDragging === next.isDragging
  && prev.dropPosition === next.dropPosition
  && prev.theme === next.theme
  && prev.onSelect === next.onSelect
  && prev.onStartRename === next.onStartRename
  && prev.onSubmitRename === next.onSubmitRename
  && prev.onCancelRename === next.onCancelRename
  && prev.onCloseSession === next.onCloseSession
  && prev.onCopySession === next.onCopySession
  && prev.onCopySessionToNewWindow === next.onCopySessionToNewWindow
  && prev.onDetachSessionFromWorkspace === next.onDetachSessionFromWorkspace
  && prev.onDragStart === next.onDragStart
  && prev.onDragOver === next.onDragOver
  && prev.onDrop === next.onDrop
  && prev.onDragEnd === next.onDragEnd
  && prev.t === next.t
));
WorkspaceFocusSessionRow.displayName = 'WorkspaceFocusSessionRow';

const TerminalFocusSidebarInner: React.FC<TerminalFocusSidebarProps> = ({
  activeWorkspace,
  focusedSessionId,
  onReorderWorkspaceSessions,
  onRequestAddToWorkspace,
  onCloseSession,
  onCopySession,
  onCopySessionToNewWindow,
  onDetachSessionFromWorkspace,
  onSetWorkspaceFocusedSession,
  onToggleWorkspaceViewMode,
  onSubmitSessionRename,
  resolvedPreviewTheme,
  sessionHostsMap,
  sessions,
  t,
}) => {
  const [focusSidebarSearch, setFocusSidebarSearch] = useState('');
  const [focusSidebarDragSessionId, setFocusSidebarDragSessionId] = useState<string | null>(null);
  const [focusSidebarDropIndicator, setFocusSidebarDropIndicator] = useState<{
    sessionId: string;
    position: 'before' | 'after';
  } | null>(null);
  const [focusSidebarWidth, setFocusSidebarWidth, persistFocusSidebarWidth] = useStoredNumber(
    STORAGE_KEY_WORKSPACE_FOCUS_SIDEBAR_WIDTH, 224, { min: 160, max: 480 },
  );

  const [sidebarRenameSessionId, setSidebarRenameSessionId] = useState<string | null>(null);
  const [sidebarRenameValue, setSidebarRenameValue] = useState('');

  const theme = useMemo<FocusSidebarTheme>(() => {
    const termBg = resolvedPreviewTheme.colors.background;
    const termFg = resolvedPreviewTheme.colors.foreground;
    return {
      termBg,
      termFg,
      selectedBg: `color-mix(in srgb, ${termFg} 10%, transparent)`,
      selectedHoverBg: `color-mix(in srgb, ${termFg} 15%, transparent)`,
      unselectedHoverBg: `color-mix(in srgb, ${termFg} 10%, transparent)`,
      unselectedFg: `color-mix(in srgb, ${termFg} 75%, ${termBg} 25%)`,
      mutedFg: `color-mix(in srgb, ${termFg} 55%, ${termBg} 45%)`,
      separator: `color-mix(in srgb, ${termFg} 10%, ${termBg} 90%)`,
    };
  }, [resolvedPreviewTheme]);

  const workspaceSessions = useMemo(() => {
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    return resolveWorkspaceFocusSessionOrder(activeWorkspace.root, activeWorkspace.focusSessionOrder)
      .map((sessionId) => sessionMap.get(sessionId))
      .filter((session): session is TerminalSession => Boolean(session));
  }, [activeWorkspace, sessions]);

  const visibleSessions = useMemo(() => {
    const term = focusSidebarSearch.trim().toLowerCase();
    if (!term) return workspaceSessions;
    return workspaceSessions.filter((session) => (
      session.customName?.toLowerCase().includes(term)
      || session.hostLabel?.toLowerCase().includes(term)
      || session.dynamicTitle?.toLowerCase().includes(term)
      || session.hostname?.toLowerCase().includes(term)
      || session.username?.toLowerCase().includes(term)
    ));
  }, [focusSidebarSearch, workspaceSessions]);

  const handleFocusSidebarResizeStart = useCallback((event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = focusSidebarWidth;

    let lastWidth = startWidth;
    let rafId: number | null = null;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      lastWidth = Math.max(160, Math.min(480, startWidth + delta));
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setFocusSidebarWidth(lastWidth);
      });
    };
    const onMouseUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      setFocusSidebarWidth(lastWidth);
      persistFocusSidebarWidth(lastWidth);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [focusSidebarWidth, persistFocusSidebarWidth, setFocusSidebarWidth]);

  const handleFocusSidebarDragStart = useCallback((event: DragEvent, sessionId: string) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('workspace-focus-session-id', sessionId);
    setFocusSidebarDragSessionId(sessionId);
  }, []);

  const getFocusSidebarContainerDropTarget = useCallback((
    container: HTMLElement,
    clientY: number,
    draggedSessionId: string,
  ): { sessionId: string; position: 'before' | 'after' } | null => {
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-workspace-focus-session-id]'),
    );
    if (rows.length === 0) return null;

    for (const row of rows) {
      const sessionId = row.dataset.workspaceFocusSessionId;
      if (!sessionId || sessionId === draggedSessionId) continue;

      const rect = row.getBoundingClientRect();
      if (clientY < rect.top) return { sessionId, position: 'before' };
      if (clientY <= rect.bottom) {
        return {
          sessionId,
          position: clientY < rect.top + rect.height / 2 ? 'before' : 'after',
        };
      }
    }

    const lastRow = [...rows].reverse().find((row) => (
      row.dataset.workspaceFocusSessionId
      && row.dataset.workspaceFocusSessionId !== draggedSessionId
    ));
    const lastSessionId = lastRow?.dataset.workspaceFocusSessionId;
    return lastSessionId ? { sessionId: lastSessionId, position: 'after' } : null;
  }, []);

  const handleFocusSidebarDragOver = useCallback((event: DragEvent, targetSessionId: string) => {
    const draggedSessionId = event.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
    if (!draggedSessionId || draggedSessionId === targetSessionId) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setFocusSidebarDropIndicator({ sessionId: targetSessionId, position });
  }, [focusSidebarDragSessionId]);

  const handleFocusSidebarContainerDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    const draggedSessionId = event.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
    if (!draggedSessionId) return;

    const target = getFocusSidebarContainerDropTarget(event.currentTarget, event.clientY, draggedSessionId);
    if (!target) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setFocusSidebarDropIndicator(target);
  }, [focusSidebarDragSessionId, getFocusSidebarContainerDropTarget]);

  const handleFocusSidebarContainerDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    const draggedSessionId = event.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
    if (!draggedSessionId) return;

    const target = focusSidebarDropIndicator
      ?? getFocusSidebarContainerDropTarget(event.currentTarget, event.clientY, draggedSessionId);
    if (!target || target.sessionId === draggedSessionId) return;

    event.preventDefault();
    onReorderWorkspaceSessions?.(activeWorkspace.id, draggedSessionId, target.sessionId, target.position);
    setFocusSidebarDragSessionId(null);
    setFocusSidebarDropIndicator(null);
  }, [
    activeWorkspace.id,
    focusSidebarDragSessionId,
    focusSidebarDropIndicator,
    getFocusSidebarContainerDropTarget,
    onReorderWorkspaceSessions,
  ]);

  const handleFocusSidebarDrop = useCallback((event: DragEvent, targetSessionId: string) => {
    const draggedSessionId = event.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
    if (!draggedSessionId || draggedSessionId === targetSessionId) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = focusSidebarDropIndicator?.sessionId === targetSessionId
      ? focusSidebarDropIndicator.position
      : event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    onReorderWorkspaceSessions?.(activeWorkspace.id, draggedSessionId, targetSessionId, position);
    setFocusSidebarDragSessionId(null);
    setFocusSidebarDropIndicator(null);
  }, [activeWorkspace.id, focusSidebarDragSessionId, focusSidebarDropIndicator, onReorderWorkspaceSessions]);

  const handleFocusSidebarDragEnd = useCallback(() => {
    setFocusSidebarDragSessionId(null);
    setFocusSidebarDropIndicator(null);
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    onSetWorkspaceFocusedSession?.(activeWorkspace.id, sessionId);
  }, [activeWorkspace.id, onSetWorkspaceFocusedSession]);

  const handleLocalStartRename = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setSidebarRenameSessionId(sessionId);
    setSidebarRenameValue(session.customName || session.hostLabel || '');
  }, [sessions]);

  const handleLocalSubmitRename = useCallback((name: string) => {
    if (!sidebarRenameSessionId) return;
    onSubmitSessionRename(sidebarRenameSessionId, name);
    setSidebarRenameSessionId(null);
    setSidebarRenameValue('');
  }, [sidebarRenameSessionId, onSubmitSessionRename]);

  const handleLocalCancelRename = useCallback(() => {
    setSidebarRenameSessionId(null);
    setSidebarRenameValue('');
  }, []);

  return (
    <div
      className="flex-shrink-0 flex flex-col relative"
      style={{
        width: focusSidebarWidth,
        backgroundColor: theme.termBg,
        color: theme.termFg,
        ['--terminal-workspace-sidebar-border' as string]: `1px solid ${theme.separator}`,
      }}
      data-section="terminal-workspace-sidebar"
    >
      <div
        className="absolute top-0 right-[-3px] h-full w-2 cursor-ew-resize z-30"
        onMouseDown={handleFocusSidebarResizeStart}
      />
      <div
        className="h-9 flex items-center gap-1 px-1.5 flex-shrink-0"
        style={{ borderBottom: `1px solid ${theme.separator}` }}
      >
        <div className="relative flex-1 min-w-0">
          <Search
            size={12}
            className="absolute left-1 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: theme.mutedFg }}
          />
          <Input
            value={focusSidebarSearch}
            onChange={(event) => setFocusSidebarSearch(event.target.value)}
            placeholder="Search terminals..."
            className="h-7 pl-6 pr-1 text-xs bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            style={{ color: theme.termFg }}
          />
        </div>
        {onRequestAddToWorkspace && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 p-0 flex-shrink-0 hover:bg-transparent hover:text-inherit"
                style={{ color: theme.mutedFg }}
                onClick={() => onRequestAddToWorkspace(activeWorkspace.id)}
              >
                <Plus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.layer.addTerminal')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 p-0 flex-shrink-0 hover:bg-transparent hover:text-inherit"
              style={{ color: theme.mutedFg }}
              onClick={() => onToggleWorkspaceViewMode?.(activeWorkspace.id)}
            >
              <Columns2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.layer.switchToSplitView')}</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1">
        <div
          className="p-2 space-y-1"
          onDragOver={handleFocusSidebarContainerDragOver}
          onDrop={handleFocusSidebarContainerDrop}
        >
          {visibleSessions.map((session) => (
            <WorkspaceFocusSessionRow
              key={session.id}
              session={session}
              host={sessionHostsMap.get(session.id)}
              isSelected={session.id === focusedSessionId}
              isRenaming={sidebarRenameSessionId === session.id}
              renameValue={sidebarRenameValue}
              onStartRename={handleLocalStartRename}
              onSubmitRename={handleLocalSubmitRename}
              onCancelRename={handleLocalCancelRename}
              onCloseSession={onCloseSession}
              onCopySession={onCopySession}
              onCopySessionToNewWindow={onCopySessionToNewWindow}
              onDetachSessionFromWorkspace={onDetachSessionFromWorkspace}
              isDragging={focusSidebarDragSessionId === session.id}
              dropPosition={
                focusSidebarDropIndicator?.sessionId === session.id
                  ? focusSidebarDropIndicator.position
                  : null
              }
              theme={theme}
              onSelect={handleSelectSession}
              onDragStart={handleFocusSidebarDragStart}
              onDragOver={handleFocusSidebarDragOver}
              onDrop={handleFocusSidebarDrop}
              onDragEnd={handleFocusSidebarDragEnd}
              t={t}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

function terminalFocusSidebarPropsEqual(
  prev: TerminalFocusSidebarProps,
  next: TerminalFocusSidebarProps,
): boolean {
  if (prev.focusedSessionId !== next.focusedSessionId) return false;
  if (prev.onSubmitSessionRename !== next.onSubmitSessionRename) return false;
  if (prev.onCloseSession !== next.onCloseSession) return false;
  if (prev.onCopySession !== next.onCopySession) return false;
  if (prev.onCopySessionToNewWindow !== next.onCopySessionToNewWindow) return false;
  if (prev.onDetachSessionFromWorkspace !== next.onDetachSessionFromWorkspace) return false;
  if (prev.resolvedPreviewTheme !== next.resolvedPreviewTheme) return false;
  if (prev.sessionHostsMap !== next.sessionHostsMap) return false;
  if (prev.sessions !== next.sessions) return false;
  if (prev.t !== next.t) return false;
  if (prev.onReorderWorkspaceSessions !== next.onReorderWorkspaceSessions) return false;
  if (prev.onRequestAddToWorkspace !== next.onRequestAddToWorkspace) return false;
  if (prev.onSetWorkspaceFocusedSession !== next.onSetWorkspaceFocusedSession) return false;
  if (prev.onToggleWorkspaceViewMode !== next.onToggleWorkspaceViewMode) return false;
  const prevWs = prev.activeWorkspace;
  const nextWs = next.activeWorkspace;
  return (
    prevWs.id === nextWs.id
    && prevWs.viewMode === nextWs.viewMode
    && prevWs.root === nextWs.root
    && prevWs.focusSessionOrder === nextWs.focusSessionOrder
  );
}

export const TerminalFocusSidebar = memo(TerminalFocusSidebarInner, terminalFocusSidebarPropsEqual);
TerminalFocusSidebar.displayName = 'TerminalFocusSidebar';
