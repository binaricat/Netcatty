import { Circle, Columns2, Plus, Search, Server } from 'lucide-react';
import { type DragEvent, type MouseEvent, useCallback, useMemo, useState } from 'react';

import { useStoredNumber } from '../../application/state/useStoredNumber';
import { resolveWorkspaceFocusSessionOrder } from '../../domain/workspace';
import { STORAGE_KEY_WORKSPACE_FOCUS_SIDEBAR_WIDTH } from '../../infrastructure/config/storageKeys';
import { cn } from '../../lib/utils';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface UseTerminalFocusSidebarOptions {
  activeWorkspace: Workspace | undefined;
  focusedSessionId: string | undefined;
  isFocusMode: boolean;
  onReorderWorkspaceSessions?: (workspaceId: string, draggedSessionId: string, targetSessionId: string, position: 'before' | 'after') => void;
  onRequestAddToWorkspace?: (workspaceId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onToggleWorkspaceViewMode?: (workspaceId: string) => void;
  resolvedPreviewTheme: TerminalTheme;
  sessionHostsMap: Map<string, Host>;
  sessions: TerminalSession[];
  t: (key: string) => string;
}

export function useTerminalFocusSidebar({
  activeWorkspace,
  focusedSessionId,
  isFocusMode,
  onReorderWorkspaceSessions,
  onRequestAddToWorkspace,
  onSetWorkspaceFocusedSession,
  onToggleWorkspaceViewMode,
  resolvedPreviewTheme,
  sessionHostsMap,
  sessions,
  t,
}: UseTerminalFocusSidebarOptions) {
  // Focus-mode sidebar: client-side filter for the terminal list.
    const [focusSidebarSearch, setFocusSidebarSearch] = useState('');
  
  const [focusSidebarDragSessionId, setFocusSidebarDragSessionId] = useState<string | null>(null);
  
  const [focusSidebarDropIndicator, setFocusSidebarDropIndicator] = useState<{
      sessionId: string;
      position: 'before' | 'after';
    } | null>(null);
  
  const [focusSidebarWidth, setFocusSidebarWidth, persistFocusSidebarWidth] = useStoredNumber(
      STORAGE_KEY_WORKSPACE_FOCUS_SIDEBAR_WIDTH, 224, { min: 160, max: 480 },
    );
  
  // Focus-mode workspace sidebar resize handler. The sidebar is always
    // anchored to the left of the workspace area, so a rightward drag grows it.
    const handleFocusSidebarResizeStart = useCallback((e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = focusSidebarWidth;
  
      let lastWidth = startWidth;
      let rafId: number | null = null;
      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
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
    }, [focusSidebarWidth, setFocusSidebarWidth, persistFocusSidebarWidth]);
  
  const workspaceSessions = useMemo(() => {
      if (!activeWorkspace) return [];
      const sessionMap = new Map(sessions.map((session) => [session.id, session]));
      return resolveWorkspaceFocusSessionOrder(activeWorkspace.root, activeWorkspace.focusSessionOrder)
        .map((sessionId) => sessionMap.get(sessionId))
        .filter((session): session is TerminalSession => Boolean(session));
    }, [activeWorkspace, sessions]);
  
  const handleFocusSidebarDragStart = useCallback((e: DragEvent, sessionId: string) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('workspace-focus-session-id', sessionId);
      setFocusSidebarDragSessionId(sessionId);
    }, []);
  
  const handleFocusSidebarDragOver = useCallback((e: DragEvent, targetSessionId: string) => {
      const draggedSessionId = e.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
      if (!activeWorkspace || !draggedSessionId || draggedSessionId === targetSessionId) return;
  
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
  
      const rect = e.currentTarget.getBoundingClientRect();
      const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setFocusSidebarDropIndicator({ sessionId: targetSessionId, position });
    }, [activeWorkspace, focusSidebarDragSessionId]);
  
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
  
  const handleFocusSidebarContainerDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
      const draggedSessionId = e.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
      if (!activeWorkspace || !draggedSessionId) return;
  
      const target = getFocusSidebarContainerDropTarget(e.currentTarget, e.clientY, draggedSessionId);
      if (!target) return;
  
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setFocusSidebarDropIndicator(target);
    }, [activeWorkspace, focusSidebarDragSessionId, getFocusSidebarContainerDropTarget]);
  
  const handleFocusSidebarContainerDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
      const draggedSessionId = e.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
      if (!activeWorkspace || !draggedSessionId) return;
  
      const target = focusSidebarDropIndicator
        ?? getFocusSidebarContainerDropTarget(e.currentTarget, e.clientY, draggedSessionId);
      if (!target || target.sessionId === draggedSessionId) return;
  
      e.preventDefault();
      onReorderWorkspaceSessions?.(activeWorkspace.id, draggedSessionId, target.sessionId, target.position);
      setFocusSidebarDragSessionId(null);
      setFocusSidebarDropIndicator(null);
    }, [
      activeWorkspace,
      focusSidebarDragSessionId,
      focusSidebarDropIndicator,
      getFocusSidebarContainerDropTarget,
      onReorderWorkspaceSessions,
    ]);
  
  const handleFocusSidebarDrop = useCallback((e: DragEvent, targetSessionId: string) => {
      const draggedSessionId = e.dataTransfer.getData('workspace-focus-session-id') || focusSidebarDragSessionId;
      if (!activeWorkspace || !draggedSessionId || draggedSessionId === targetSessionId) return;
  
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const position = focusSidebarDropIndicator?.sessionId === targetSessionId
        ? focusSidebarDropIndicator.position
        : e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      onReorderWorkspaceSessions?.(activeWorkspace.id, draggedSessionId, targetSessionId, position);
      setFocusSidebarDragSessionId(null);
      setFocusSidebarDropIndicator(null);
    }, [activeWorkspace, focusSidebarDragSessionId, focusSidebarDropIndicator, onReorderWorkspaceSessions]);
  
  const handleFocusSidebarDragEnd = useCallback(() => {
      setFocusSidebarDragSessionId(null);
      setFocusSidebarDropIndicator(null);
    }, []);
  
  // Render focus mode sidebar
    const renderFocusModeSidebar = () => {
      if (!activeWorkspace || !isFocusMode) return null;
  
      // Use terminal-theme colors for every surface in here so the sidebar
      // stays readable when the app theme and terminal theme diverge
      // (e.g. followAppTerminalTheme=off, light app + dark terminal).
      // Tailwind's bg-foreground/* / text-foreground classes bind to app
      // theme vars, so we derive row colors from the terminal theme
      // directly with color-mix.
      const termBg = resolvedPreviewTheme.colors.background;
      const termFg = resolvedPreviewTheme.colors.foreground;
      const selectedBg = `color-mix(in srgb, ${termFg} 10%, transparent)`;
      const selectedHoverBg = `color-mix(in srgb, ${termFg} 15%, transparent)`;
      const unselectedHoverBg = `color-mix(in srgb, ${termFg} 10%, transparent)`;
      const unselectedFg = `color-mix(in srgb, ${termFg} 75%, ${termBg} 25%)`;
      const mutedFg = `color-mix(in srgb, ${termFg} 55%, ${termBg} 45%)`;
      const separator = `color-mix(in srgb, ${termFg} 10%, ${termBg} 90%)`;
  
      return (
        <div
          className="flex-shrink-0 flex flex-col relative"
          style={{
            width: focusSidebarWidth,
            // Paint the sidebar with the terminal's theme background so it
            // reads as one continuous surface with the focused terminal
            // (instead of a distinct tinted panel sitting next to it).
            backgroundColor: termBg,
            color: termFg,
            ['--terminal-workspace-sidebar-border' as string]: `1px solid ${separator}`,
          }}
          data-section="terminal-workspace-sidebar"
        >
          {/* Resize handle sitting on the right edge of the sidebar. */}
          <div
            className="absolute top-0 right-[-3px] h-full w-2 cursor-ew-resize z-30"
            onMouseDown={handleFocusSidebarResizeStart}
          />
          {/* Header — search box + actions (matches Vault-sidebar search
              style but skinned to the terminal theme so it blends with the
              sidebar's bg). */}
          <div
            className="h-11 flex items-center gap-1.5 px-2"
            style={{ borderBottom: `1px solid ${separator}` }}
          >
            <div className="relative flex-1 min-w-0">
              <Search
                size={12}
                className="absolute left-1 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: mutedFg }}
              />
              <Input
                value={focusSidebarSearch}
                onChange={(e) => setFocusSidebarSearch(e.target.value)}
                placeholder="Search terminals..."
                className="h-7 pl-6 pr-0 text-xs bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                style={{ color: termFg }}
              />
            </div>
            {onRequestAddToWorkspace && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 flex-shrink-0 hover:text-inherit"
                    style={{ color: mutedFg }}
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
                  size="sm"
                  className="h-7 w-7 p-0 flex-shrink-0 hover:text-inherit"
                  style={{ color: mutedFg }}
                  onClick={() => onToggleWorkspaceViewMode?.(activeWorkspace.id)}
                >
                  <Columns2 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.layer.switchToSplitView')}</TooltipContent>
            </Tooltip>
          </div>
  
          {/* Session list */}
          <ScrollArea className="flex-1">
            <div
              className="p-2 space-y-1"
              onDragOver={handleFocusSidebarContainerDragOver}
              onDrop={handleFocusSidebarContainerDrop}
            >
              {workspaceSessions.filter((session) => {
                const term = focusSidebarSearch.trim().toLowerCase();
                if (!term) return true;
                return (
                  session.hostLabel?.toLowerCase().includes(term)
                  || session.hostname?.toLowerCase().includes(term)
                  || session.username?.toLowerCase().includes(term)
                );
              }).map(session => {
                const host = sessionHostsMap.get(session.id);
                const isSelected = session.id === focusedSessionId;
                const statusColor = session.status === 'connected'
                  ? 'text-emerald-500'
                  : session.status === 'connecting'
                    ? 'text-amber-500'
                    : 'text-red-500';
  
                const restBg = isSelected ? selectedBg : 'transparent';
                const hoverBg = isSelected ? selectedHoverBg : unselectedHoverBg;
                const rowFg = isSelected ? termFg : unselectedFg;
                const dropPosition = focusSidebarDropIndicator?.sessionId === session.id
                  ? focusSidebarDropIndicator.position
                  : null;
                const isDragging = focusSidebarDragSessionId === session.id;
  
                return (
                  <div
                    key={session.id}
                    data-workspace-focus-session-id={session.id}
                    draggable
                    role="button"
                    tabIndex={0}
                    // Row colors are terminal-theme derived (see renderFocusModeSidebar
                    // top). `hover:text-inherit` pins text against ghost variant's
                    // hover:text-accent-foreground default; hover bg is swapped
                    // via inline style so we stay on terminal-theme alpha rather
                    // than Tailwind's app-theme foreground color.
                    className={cn(
                      "relative flex w-full select-none items-center justify-start gap-2 rounded-md px-2 py-1.5 text-sm font-normal outline-none transition-colors hover:text-inherit focus-visible:ring-1 cursor-grab active:cursor-grabbing",
                      isDragging && "opacity-50",
                    )}
                    style={{
                      backgroundColor: restBg,
                      color: rowFg,
                      boxShadow: dropPosition
                        ? `inset 0 ${dropPosition === 'before' ? '2px' : '-2px'} 0 ${termFg}`
                        : undefined,
                    }}
                    onDragStart={(e) => handleFocusSidebarDragStart(e, session.id)}
                    onDragOver={(e) => handleFocusSidebarDragOver(e, session.id)}
                    onDragLeave={(e) => {
                      e.stopPropagation();
                    }}
                    onDrop={(e) => handleFocusSidebarDrop(e, session.id)}
                    onDragEnd={handleFocusSidebarDragEnd}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = restBg;
                    }}
                    onClick={() => onSetWorkspaceFocusedSession?.(activeWorkspace.id, session.id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      onSetWorkspaceFocusedSession?.(activeWorkspace.id, session.id);
                    }}
                  >
                    <div className="relative flex-shrink-0">
                      {host ? (
                        <DistroAvatar host={host} fallback={session.hostLabel} size="sm" />
                      ) : (
                        <Server size={16} style={{ color: mutedFg }} />
                      )}
                      <Circle
                        size={6}
                        className={cn("absolute -bottom-0.5 -right-0.5 fill-current", statusColor)}
                      />
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <div className={cn("text-xs truncate", isSelected ? "font-semibold" : "font-medium")}>
                        {session.hostLabel}
                      </div>
                      <div className="text-[10px] truncate" style={{ color: mutedFg }}>
                        {session.username}@{session.hostname}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      );
    };

  return { renderFocusModeSidebar };
}
