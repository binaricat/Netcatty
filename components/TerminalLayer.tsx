import React, { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { cn } from '../lib/utils';
import Terminal from './Terminal';
import { Host, SSHKey, Snippet, TerminalSession, TerminalTheme, Workspace, WorkspaceNode, KnownHost } from '../types';
import { useActiveTabId } from '../application/state/activeTabStore';
import { collectSessionIds } from '../domain/workspace';
import { DistroAvatar } from './DistroAvatar';
import { Button } from './ui/button';
import { LayoutGrid, Server, Circle } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';

type WorkspaceRect = { x: number; y: number; w: number; h: number };

type SplitHint = {
  direction: 'horizontal' | 'vertical';
  position: 'left' | 'right' | 'top' | 'bottom';
  targetSessionId?: string;
  rect?: { x: number; y: number; w: number; h: number };
} | null;

type ResizerHandle = {
  id: string;
  splitId: string;
  index: number;
  direction: 'vertical' | 'horizontal';
  rect: { x: number; y: number; w: number; h: number };
  splitArea: { w: number; h: number };
};

interface TerminalLayerProps {
  hosts: Host[];
  keys: SSHKey[];
  snippets: Snippet[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  knownHosts?: KnownHost[];
  draggingSessionId: string | null;
  terminalTheme: TerminalTheme;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onUpdateSessionStatus: (sessionId: string, status: TerminalSession['status']) => void;
  onUpdateHostDistro: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onUpdateSplitSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  onSetDraggingSessionId: (id: string | null) => void;
  onToggleWorkspaceViewMode?: (workspaceId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
}

const TerminalLayerInner: React.FC<TerminalLayerProps> = ({
  hosts,
  keys,
  snippets,
  sessions,
  workspaces,
  knownHosts = [],
  draggingSessionId,
  terminalTheme,
  onCloseSession,
  onUpdateSessionStatus,
  onUpdateHostDistro,
  onUpdateHost,
  onAddKnownHost,
  onCreateWorkspaceFromSessions,
  onAddSessionToWorkspace,
  onUpdateSplitSizes,
  onSetDraggingSessionId,
  onToggleWorkspaceViewMode,
  onSetWorkspaceFocusedSession,
}) => {
  // Subscribe to activeTabId from external store
  const activeTabId = useActiveTabId();
  const isVaultActive = activeTabId === 'vault';
  const isSftpActive = activeTabId === 'sftp';
  const isVisible = (!isVaultActive && !isSftpActive) || !!draggingSessionId;

  // Stable callback references for Terminal components
  const handleCloseSession = useCallback((sessionId: string) => {
    onCloseSession(sessionId);
  }, [onCloseSession]);

  const handleStatusChange = useCallback((sessionId: string, status: TerminalSession['status']) => {
    onUpdateSessionStatus(sessionId, status);
  }, [onUpdateSessionStatus]);

  const handleSessionExit = useCallback((sessionId: string) => {
    onUpdateSessionStatus(sessionId, 'disconnected');
  }, [onUpdateSessionStatus]);

  const handleOsDetected = useCallback((hostId: string, distro: string) => {
    onUpdateHostDistro(hostId, distro);
  }, [onUpdateHostDistro]);

  const handleUpdateHost = useCallback((host: Host) => {
    onUpdateHost(host);
  }, [onUpdateHost]);

  const handleAddKnownHost = useCallback((knownHost: KnownHost) => {
    onAddKnownHost?.(knownHost);
  }, [onAddKnownHost]);

  const [workspaceArea, setWorkspaceArea] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const workspaceOuterRef = useRef<HTMLDivElement>(null);
  const workspaceInnerRef = useRef<HTMLDivElement>(null);
  const workspaceOverlayRef = useRef<HTMLDivElement>(null);
  const [dropHint, setDropHint] = useState<SplitHint>(null);
  const [resizing, setResizing] = useState<{
    workspaceId: string;
    splitId: string;
    index: number;
    direction: 'vertical' | 'horizontal';
    startSizes: number[];
    startArea: { w: number; h: number };
    startClient: { x: number; y: number };
  } | null>(null);

  const activeWorkspace = useMemo(() => workspaces.find(w => w.id === activeTabId), [workspaces, activeTabId]);
  const activeSession = useMemo(() => sessions.find(s => s.id === activeTabId), [sessions, activeTabId]);

  // Pre-compute host lookup map for O(1) access
  const hostMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  // Pre-compute fallback hosts to avoid creating new objects on every render
  const sessionHostsMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const session of sessions) {
      const existingHost = hostMap.get(session.hostId);
      if (existingHost) {
        map.set(session.id, existingHost);
      } else {
        // Create stable fallback host object
        map.set(session.id, {
          id: session.hostId,
          label: session.hostLabel || 'Local Terminal',
          hostname: session.hostname || 'localhost',
          username: session.username || 'local',
          port: 22,
          os: 'linux',
          group: '',
          tags: [],
          protocol: 'local' as const,
        });
      }
    }
    return map;
  }, [sessions, hostMap]);

  const computeWorkspaceRects = useCallback((workspace?: Workspace, size?: { width: number; height: number }): Record<string, WorkspaceRect> => {
    if (!workspace) return {} as Record<string, WorkspaceRect>;
    const wTotal = size?.width || 1;
    const hTotal = size?.height || 1;
    const rects: Record<string, WorkspaceRect> = {};
    const walk = (node: WorkspaceNode, area: WorkspaceRect) => {
      if (node.type === 'pane') {
        rects[node.sessionId] = area;
        return;
      }
      const isVertical = node.direction === 'vertical';
      const sizes = (node.sizes && node.sizes.length === node.children.length ? node.sizes : Array(node.children.length).fill(1));
      const total = sizes.reduce((acc, n) => acc + n, 0) || 1;
      let offset = 0;
      node.children.forEach((child, idx) => {
        const share = sizes[idx] / total;
        const childArea = isVertical
          ? { x: area.x + area.w * offset, y: area.y, w: area.w * share, h: area.h }
          : { x: area.x, y: area.y + area.h * offset, w: area.w, h: area.h * share };
        walk(child, childArea);
        offset += share;
      });
    };
    walk(workspace.root, { x: 0, y: 0, w: wTotal, h: hTotal });
    return rects;
  }, []);

  const activeWorkspaceRects = useMemo<Record<string, WorkspaceRect>>(
    () => computeWorkspaceRects(activeWorkspace, workspaceArea),
    [activeWorkspace, workspaceArea, computeWorkspaceRects]
  );

  useEffect(() => {
    if (!workspaceInnerRef.current) return;
    const el = workspaceInnerRef.current;
    const updateSize = () => setWorkspaceArea({ width: el.clientWidth, height: el.clientHeight });
    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeWorkspace]);

  const collectResizers = useCallback((workspace?: Workspace, size?: { width: number; height: number }): ResizerHandle[] => {
    if (!workspace || !size?.width || !size?.height) return [];
    const resizers: ResizerHandle[] = [];
    const walk = (node: WorkspaceNode, area: { x: number; y: number; w: number; h: number }) => {
      if (node.type === 'pane') return;
      const isVertical = node.direction === 'vertical';
      const sizes = (node.sizes && node.sizes.length === node.children.length ? node.sizes : Array(node.children.length).fill(1));
      const total = sizes.reduce((acc, n) => acc + n, 0) || 1;
      let offset = 0;
      node.children.forEach((child, idx) => {
        const share = sizes[idx] / total;
        const childArea = isVertical
          ? { x: area.x + area.w * offset, y: area.y, w: area.w * share, h: area.h }
          : { x: area.x, y: area.y + area.h * offset, w: area.w, h: area.h * share };
        if (idx < node.children.length - 1) {
          const boundary = isVertical ? childArea.x + childArea.w : childArea.y + childArea.h;
          const rect = isVertical
            ? { x: boundary - 2, y: area.y, w: 4, h: area.h }
            : { x: area.x, y: boundary - 2, w: area.w, h: 4 };
          resizers.push({
            id: `${node.id}-${idx}`,
            splitId: node.id,
            index: idx,
            direction: node.direction,
            rect,
            splitArea: { w: area.w, h: area.h },
          });
        }
        walk(child, childArea);
        offset += share;
      });
    };
    walk(workspace.root, { x: 0, y: 0, w: size.width, h: size.height });
    return resizers;
  }, []);

  const activeResizers = useMemo(() => collectResizers(activeWorkspace, workspaceArea), [activeWorkspace, workspaceArea, collectResizers]);

  const computeSplitHint = (e: React.DragEvent): SplitHint => {
    const surface = workspaceOverlayRef.current || workspaceInnerRef.current || workspaceOuterRef.current;
    if (!surface || !workspaceArea.width || !workspaceArea.height) return null;
    const rect = surface.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) return null;

    let targetSessionId: string | undefined;
    let targetRect: WorkspaceRect | undefined;
    const workspaceEntries = Object.entries(activeWorkspaceRects) as Array<[string, WorkspaceRect]>;
    workspaceEntries.forEach(([sessionId, area]) => {
      if (targetSessionId) return;
      if (
        localX >= area.x &&
        localX <= area.x + area.w &&
        localY >= area.y &&
        localY <= area.y + area.h
      ) {
        targetSessionId = sessionId;
        targetRect = area;
      }
    });

    const baseRect: WorkspaceRect = targetRect || { x: 0, y: 0, w: rect.width, h: rect.height };
    const relX = (localX - baseRect.x) / baseRect.w;
    const relY = (localY - baseRect.y) / baseRect.h;

    const prefersVertical = Math.abs(relX - 0.5) > Math.abs(relY - 0.5);
    const direction = prefersVertical ? 'vertical' : 'horizontal';
    const position = prefersVertical
      ? (relX < 0.5 ? 'left' : 'right')
      : (relY < 0.5 ? 'top' : 'bottom');

    const previewRect: WorkspaceRect = { ...baseRect };
    if (direction === 'vertical') {
      previewRect.w = baseRect.w / 2;
      previewRect.x = position === 'left' ? baseRect.x : baseRect.x + baseRect.w / 2;
    } else {
      previewRect.h = baseRect.h / 2;
      previewRect.y = position === 'top' ? baseRect.y : baseRect.y + baseRect.h / 2;
    }

    return {
      direction,
      position,
      targetSessionId,
      rect: previewRect,
    };
  };

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const dimension = resizing.direction === 'vertical' ? resizing.startArea.w : resizing.startArea.h;
      if (dimension <= 0) return;
      const total = resizing.startSizes.reduce((acc, n) => acc + n, 0) || 1;
      const pxSizes = resizing.startSizes.map(s => (s / total) * dimension);
      const i = resizing.index;
      const delta = (resizing.direction === 'vertical' ? e.clientX - resizing.startClient.x : e.clientY - resizing.startClient.y);
      let a = pxSizes[i] + delta;
      let b = pxSizes[i + 1] - delta;
      const minPx = Math.min(120, dimension / 2);
      if (a < minPx) {
        const diff = minPx - a;
        a = minPx;
        b -= diff;
      }
      if (b < minPx) {
        const diff = minPx - b;
        b = minPx;
        a -= diff;
      }
      const newPxSizes = [...pxSizes];
      newPxSizes[i] = Math.max(minPx, a);
      newPxSizes[i + 1] = Math.max(minPx, b);
      const totalPx = newPxSizes.reduce((acc, n) => acc + n, 0) || 1;
      const newSizes = newPxSizes.map(n => n / totalPx);
      onUpdateSplitSizes(resizing.workspaceId, resizing.splitId, newSizes);
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing, onUpdateSplitSizes]);

  const handleWorkspaceDrop = (e: React.DragEvent) => {
    const draggedSessionId = e.dataTransfer.getData('session-id');
    if (!draggedSessionId) return;
    e.preventDefault();
    const hint = computeSplitHint(e);
    setDropHint(null);
    onSetDraggingSessionId(null);
    if (!hint) return;

    if (activeWorkspace) {
      const draggedSession = sessions.find(s => s.id === draggedSessionId);
      if (!draggedSession || draggedSession.workspaceId) return;
      onAddSessionToWorkspace(activeWorkspace.id, draggedSessionId, hint);
      return;
    }

    if (activeSession) {
      onCreateWorkspaceFromSessions(activeSession.id, draggedSessionId, hint);
    }
  };

  const findSplitNode = (node: WorkspaceNode, splitId: string): WorkspaceNode | null => {
    if (node.type === 'split') {
      if (node.id === splitId) return node;
      for (const child of node.children) {
        const found = findSplitNode(child, splitId);
        if (found) return found;
      }
    }
    return null;
  };

  const isTerminalLayerVisible = isVisible || !!draggingSessionId;

  // Check if active workspace is in focus mode
  const isFocusMode = activeWorkspace?.viewMode === 'focus';
  const focusedSessionId = activeWorkspace?.focusedSessionId;
  
  // Get sessions for the active workspace in focus mode
  const workspaceSessionIds = useMemo(() => {
    if (!activeWorkspace) return [];
    return collectSessionIds(activeWorkspace.root);
  }, [activeWorkspace]);

  const workspaceSessions = useMemo(() => {
    return sessions.filter(s => workspaceSessionIds.includes(s.id));
  }, [sessions, workspaceSessionIds]);

  // Render focus mode sidebar
  const renderFocusModeSidebar = () => {
    if (!activeWorkspace || !isFocusMode) return null;
    
    return (
      <div className="w-56 flex-shrink-0 bg-secondary/50 border-r border-border/50 flex flex-col">
        {/* Header with view toggle */}
        <div className="h-10 flex items-center justify-between px-3 border-b border-border/50">
          <span className="text-xs font-medium text-muted-foreground">
            Terminals · {workspaceSessions.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onToggleWorkspaceViewMode?.(activeWorkspace.id)}
            title="Switch to Split View"
          >
            <LayoutGrid size={14} />
          </Button>
        </div>
        
        {/* Session list */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {workspaceSessions.map(session => {
              const host = sessionHostsMap.get(session.id);
              const isSelected = session.id === focusedSessionId;
              const statusColor = session.status === 'connected' 
                ? 'text-emerald-500' 
                : session.status === 'connecting' 
                  ? 'text-amber-500' 
                  : 'text-red-500';
              
              return (
                <div
                  key={session.id}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
                    isSelected 
                      ? "bg-primary/15 border border-primary/30" 
                      : "hover:bg-secondary/80 border border-transparent"
                  )}
                  onClick={() => onSetWorkspaceFocusedSession?.(activeWorkspace.id, session.id)}
                >
                  <div className="relative">
                    {host ? (
                      <DistroAvatar host={host} fallback={session.hostLabel} size="sm" className="h-6 w-6" />
                    ) : (
                      <Server size={16} className="text-muted-foreground" />
                    )}
                    <Circle 
                      size={6} 
                      className={cn("absolute -bottom-0.5 -right-0.5 fill-current", statusColor)} 
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{session.hostLabel}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
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

  return (
    <div
      ref={workspaceOuterRef}
      className="absolute inset-0 bg-background flex"
      style={{ display: isTerminalLayerVisible ? 'flex' : 'none', zIndex: isTerminalLayerVisible ? 10 : 0 }}
    >
      {/* Focus mode sidebar */}
      {isFocusMode && renderFocusModeSidebar()}
      
      {draggingSessionId && (
        <div
          ref={workspaceOverlayRef}
          className="absolute inset-0 z-30"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('session-id')) return;
            e.preventDefault();
            e.stopPropagation();
            const hint = computeSplitHint(e);
            setDropHint(hint);
          }}
          onDragLeave={(e) => {
            if (!e.dataTransfer.types.includes('session-id')) return;
            setDropHint(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleWorkspaceDrop(e);
          }}
        >
          {dropHint && (
            <div className="absolute inset-0 pointer-events-none">
              <div
                className="absolute bg-emerald-600/35 border border-emerald-400/70 backdrop-blur-sm transition-all duration-150"
                style={{
                  width: dropHint.rect ? `${dropHint.rect.w}px` : dropHint.direction === 'vertical' ? '50%' : '100%',
                  height: dropHint.rect ? `${dropHint.rect.h}px` : dropHint.direction === 'vertical' ? '100%' : '50%',
                  left: dropHint.rect ? `${dropHint.rect.x}px` : dropHint.direction === 'vertical' ? (dropHint.position === 'left' ? 0 : '50%') : 0,
                  top: dropHint.rect ? `${dropHint.rect.y}px` : dropHint.direction === 'vertical' ? 0 : (dropHint.position === 'top' ? 0 : '50%'),
                }}
              />
            </div>
          )}
        </div>
      )}
      <div ref={workspaceInnerRef} className={cn("absolute overflow-hidden", isFocusMode ? "left-56 right-0 top-0 bottom-0" : "inset-0")}>
        {sessions.map(session => {
          // Use pre-computed host to avoid creating new objects on every render
          const host = sessionHostsMap.get(session.id)!;
          const inActiveWorkspace = !!activeWorkspace && session.workspaceId === activeWorkspace.id;
          const isActiveSolo = activeTabId === session.id && !activeWorkspace && isTerminalLayerVisible;
          
          // In focus mode, only the focused session is visible
          const isFocusedInWorkspace = isFocusMode && inActiveWorkspace && session.id === focusedSessionId;
          const isSplitViewVisible = !isFocusMode && inActiveWorkspace;
          
          const isVisible = ((isFocusedInWorkspace || isSplitViewVisible || isActiveSolo) && isTerminalLayerVisible);
          
          // In focus mode, use full area; in split mode, use computed rects
          const rect = (isSplitViewVisible && !isFocusMode) ? activeWorkspaceRects[session.id] : null;

          const layoutStyle = rect
            ? {
              left: `${rect.x}px`,
              top: `${rect.y}px`,
              width: `${rect.w}px`,
              height: `${rect.h}px`,
            }
            : { left: 0, top: 0, width: '100%', height: '100%' };

          const style: React.CSSProperties = { ...layoutStyle };

          if (!isVisible) {
            style.display = 'none';
          }

          return (
            <div
              key={session.id}
              className={cn(
                "absolute bg-background",
                inActiveWorkspace && "workspace-pane",
                isVisible && "z-10"
              )}
              style={style}
              tabIndex={-1}
            >
              <Terminal
                host={host}
                keys={keys}
                snippets={snippets}
                allHosts={hosts}
                knownHosts={knownHosts}
                isVisible={isVisible}
                inWorkspace={inActiveWorkspace}
                isResizing={!!resizing}
                isFocusMode={isFocusMode}
                fontSize={14}
                terminalTheme={terminalTheme}
                sessionId={session.id}
                startupCommand={session.startupCommand}
                onCloseSession={handleCloseSession}
                onStatusChange={handleStatusChange}
                onSessionExit={handleSessionExit}
                onOsDetected={handleOsDetected}
                onUpdateHost={handleUpdateHost}
                onAddKnownHost={handleAddKnownHost}
                onExpandToFocus={inActiveWorkspace && !isFocusMode && activeWorkspace ? () => onToggleWorkspaceViewMode?.(activeWorkspace.id) : undefined}
              />
            </div>
          );
        })}
        {/* Only show resizers in split view mode, not in focus mode */}
        {!isFocusMode && activeResizers.map(handle => {
          const isVertical = handle.direction === 'vertical';
          // Expand hit area perpendicular to the split line, but stay within bounds
          // Vertical split (left-right): expand horizontally, keep vertical bounds
          // Horizontal split (top-bottom): expand vertically, keep horizontal bounds
          const left = isVertical ? handle.rect.x - 3 : handle.rect.x;
          const top = isVertical ? handle.rect.y : handle.rect.y - 3;
          const width = isVertical ? handle.rect.w + 6 : handle.rect.w;
          const height = isVertical ? handle.rect.h : handle.rect.h + 6;

          return (
            <div
              key={handle.id}
              className={cn("absolute group", isVertical ? "cursor-ew-resize" : "cursor-ns-resize")}
              style={{
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
                zIndex: 25,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const ws = activeWorkspace;
                if (!ws) return;
                const split = findSplitNode(ws.root, handle.splitId);
                const childCount = split && split.type === 'split' ? split.children.length : 0;
                const sizes = split && split.type === 'split' && split.sizes && split.sizes.length === childCount
                  ? split.sizes
                  : Array(childCount).fill(1);
                setResizing({
                  workspaceId: ws.id,
                  splitId: handle.splitId,
                  index: handle.index,
                  direction: handle.direction,
                  startSizes: sizes.length ? sizes : [1, 1],
                  startArea: handle.splitArea,
                  startClient: { x: e.clientX, y: e.clientY },
                });
              }}
            >
              <div
                className={cn(
                  "absolute bg-border/70 group-hover:bg-primary/60 transition-colors",
                  isVertical ? "w-px h-full left-1/2 -translate-x-1/2" : "h-px w-full top-1/2 -translate-y-1/2"
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Only re-render when data props change - activeTabId/isVisible are now managed internally via store subscription
const terminalLayerAreEqual = (prev: TerminalLayerProps, next: TerminalLayerProps): boolean => {
  return (
    prev.hosts === next.hosts &&
    prev.keys === next.keys &&
    prev.snippets === next.snippets &&
    prev.sessions === next.sessions &&
    prev.workspaces === next.workspaces &&
    prev.draggingSessionId === next.draggingSessionId &&
    prev.terminalTheme === next.terminalTheme &&
    prev.onUpdateHost === next.onUpdateHost &&
    prev.onToggleWorkspaceViewMode === next.onToggleWorkspaceViewMode &&
    prev.onSetWorkspaceFocusedSession === next.onSetWorkspaceFocusedSession
  );
};

export const TerminalLayer = memo(TerminalLayerInner, terminalLayerAreEqual);
TerminalLayer.displayName = 'TerminalLayer';
