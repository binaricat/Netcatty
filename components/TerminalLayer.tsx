import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import Terminal from './Terminal';
import AssistantPanel from './AssistantPanel';
import { Host, SSHKey, Snippet, TerminalSession, TerminalTheme, Workspace, WorkspaceNode } from '../types';

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
  activeTabId: string;
  draggingSessionId: string | null;
  isVisible: boolean;
  terminalTheme: TerminalTheme;
  showAssistant: boolean;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onUpdateSessionStatus: (sessionId: string, status: TerminalSession['status']) => void;
  onUpdateHostDistro: (hostId: string, distro: string) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onUpdateSplitSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  onSetDraggingSessionId: (id: string | null) => void;
}

export const TerminalLayer: React.FC<TerminalLayerProps> = ({
  hosts,
  keys,
  snippets,
  sessions,
  workspaces,
  activeTabId,
  draggingSessionId,
  isVisible,
  terminalTheme,
  showAssistant,
  onCloseSession,
  onUpdateSessionStatus,
  onUpdateHostDistro,
  onCreateWorkspaceFromSessions,
  onAddSessionToWorkspace,
  onUpdateSplitSizes,
  onSetDraggingSessionId,
}) => {
  const [workspaceArea, setWorkspaceArea] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const workspaceOuterRef = useRef<HTMLDivElement>(null);
  const workspaceInnerRef = useRef<HTMLDivElement>(null);
  const workspaceOverlayRef = useRef<HTMLDivElement>(null);
  const [dropHint, setDropHint] = useState<SplitHint>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
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

  const computeWorkspaceRects = (workspace?: Workspace, size?: { width: number; height: number }): Record<string, WorkspaceRect> => {
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
  };

  const activeWorkspaceRects = useMemo<Record<string, WorkspaceRect>>(
    () => computeWorkspaceRects(activeWorkspace, workspaceArea),
    [activeWorkspace, workspaceArea]
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

  const collectResizers = (workspace?: Workspace, size?: { width: number; height: number }): ResizerHandle[] => {
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
  };

  const activeResizers = useMemo(() => collectResizers(activeWorkspace, workspaceArea), [activeWorkspace, workspaceArea]);

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

  return (
    <div
      ref={workspaceOuterRef}
      className="absolute inset-0 bg-background flex"
      style={{ display: isTerminalLayerVisible ? 'flex' : 'none', zIndex: isTerminalLayerVisible ? 10 : 0 }}
    >
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
      <div ref={workspaceInnerRef} className="absolute inset-0 p-3">
        {sessions.map(session => {
          const host = hosts.find(h => h.id === session.hostId) || {
            id: session.hostId,
            label: session.hostLabel || 'Local Terminal',
            hostname: session.hostname || 'localhost',
            username: session.username || 'local',
            port: 22,
            os: 'linux',
            group: '',
            tags: [],
            protocol: 'local' as const,
          };
          const inActiveWorkspace = !!activeWorkspace && session.workspaceId === activeWorkspace.id;
          const isActiveSolo = activeTabId === session.id && !activeWorkspace && isTerminalLayerVisible;
          const isVisible = (inActiveWorkspace || isActiveSolo) && isTerminalLayerVisible;
          const rect = inActiveWorkspace ? activeWorkspaceRects[session.id] : null;
          const isFocused = focusedSessionId === session.id && isVisible;

          const layoutStyle = rect
            ? {
              left: `${rect.x}px`,
              top: `${rect.y}px`,
              width: `${rect.w}px`,
              height: `${rect.h}px`,
            }
            : { left: 0, top: 0, width: '100%', height: '100%' };

          const style: React.CSSProperties = isFocused
            ? {
              ...layoutStyle,
              outline: '2px solid hsl(var(--primary))',
              outlineOffset: -4,
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
            }
            : { ...layoutStyle };

          if (!isVisible) {
            style.display = 'none';
          }

          return (
            <div
              key={session.id}
              className={cn(
                "absolute bg-background border border-border/60",
                isVisible && "z-10"
              )}
              style={style}
              onClick={() => setFocusedSessionId(session.id)}
            >
              <Terminal
                host={host}
                keys={keys}
                snippets={snippets}
                isVisible={isVisible}
                inWorkspace={inActiveWorkspace}
                fontSize={14}
                terminalTheme={terminalTheme}
                sessionId={session.id}
                onCloseSession={() => onCloseSession(session.id)}
                onStatusChange={(next) => onUpdateSessionStatus(session.id, next)}
                onSessionExit={() => onUpdateSessionStatus(session.id, 'disconnected')}
                onOsDetected={(hid, distro) => onUpdateHostDistro(hid, distro)}
              />
            </div>
          );
        })}
        {activeResizers.map(handle => (
          <div
            key={handle.id}
            className={cn("absolute group", handle.direction === 'vertical' ? "cursor-ew-resize" : "cursor-ns-resize")}
            style={{
              left: `${handle.rect.x - 3}px`,
              top: `${handle.rect.y - 3}px`,
              width: `${handle.rect.w + 6}px`,
              height: `${handle.rect.h + 6}px`,
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
                handle.direction === 'vertical' ? "w-px h-full left-1/2 -translate-x-1/2" : "h-px w-full top-1/2 -translate-y-1/2"
              )}
              style={{
                top: handle.direction === 'vertical' ? 0 : undefined,
                left: handle.direction === 'vertical' ? undefined : 0,
              }}
            />
          </div>
        ))}
      </div>
      {showAssistant && (
        <div className="absolute right-0 top-0 bottom-0 z-20 shadow-2xl animate-in slide-in-from-right-10">
          <AssistantPanel />
        </div>
      )}
    </div>
  );
};
