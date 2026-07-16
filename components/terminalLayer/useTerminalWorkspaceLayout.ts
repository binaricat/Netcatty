import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import type { TerminalSession, Workspace, WorkspaceNode } from '../../types';
import type { ResizerHandle, SplitHint, WorkspaceRect } from './TerminalLayerSupport';
import {
  computeSplitSizesFromDelta,
  patchWorkspaceSplitSizes,
  type WorkspaceResizeSession,
} from './workspaceSplitResize';

// Pure recursive lookup — module-level so its identity is stable across renders
// (it was previously recreated every render, churning the workspace-section memo).
function findSplitNode(node: WorkspaceNode, splitId: string): WorkspaceNode | null {
  if (node.type === 'split') {
    if (node.id === splitId) return node;
    for (const child of node.children) {
      const found = findSplitNode(child, splitId);
      if (found) return found;
    }
  }
  return null;
}

interface UseTerminalWorkspaceLayoutOptions {
  activeSession: TerminalSession | undefined;
  activeWorkspace: Workspace | undefined;
  isFocusMode: boolean;
  shouldKeepHiddenWorkspaceLaidOut: (workspace: Workspace) => boolean;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onSetDraggingSessionId: (id: string | null) => void;
  onUpdateSplitSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  sessions: TerminalSession[];
  workspaces: Workspace[];
}

export function useTerminalWorkspaceLayout({
  activeSession,
  activeWorkspace,
  isFocusMode,
  shouldKeepHiddenWorkspaceLaidOut,
  onAddSessionToWorkspace,
  onCreateWorkspaceFromSessions,
  onSetDraggingSessionId,
  onUpdateSplitSizes,
  sessions,
  workspaces,
}: UseTerminalWorkspaceLayoutOptions) {
  const [workspaceArea, setWorkspaceArea] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  
  const workspaceOuterRef = useRef<HTMLDivElement>(null);
  
  const workspaceInnerRef = useRef<HTMLDivElement>(null);
  
  const workspaceOverlayRef = useRef<HTMLDivElement>(null);
  
  const [dropHint, setDropHint] = useState<SplitHint>(null);
  
  const [resizing, setResizing] = useState<WorkspaceResizeSession | null>(null);
  const [resizePreviewDelta, setResizePreviewDelta] = useState(0);
  const resizePreviewDeltaRef = useRef(0);

  useEffect(() => {
    if (!resizing) return;

    terminalLayoutSuppressStore.begin();
    resizePreviewDeltaRef.current = 0;
    setResizePreviewDelta(0);

    let rafId: number | null = null;
    const onMove = (e: MouseEvent) => {
      const delta = resizing.direction === 'vertical'
        ? e.clientX - resizing.startClient.x
        : e.clientY - resizing.startClient.y;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        resizePreviewDeltaRef.current = delta;
        setResizePreviewDelta(delta);
      });
    };
    const onUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      const finalSizes = computeSplitSizesFromDelta(resizing, resizePreviewDeltaRef.current);
      onUpdateSplitSizes(resizing.workspaceId, resizing.splitId, finalSizes);
      setResizing(null);
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = resizing.direction === 'vertical' ? 'ew-resize' : 'ns-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      terminalLayoutSuppressStore.end();
    };
  }, [resizing, onUpdateSplitSizes]);
  
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
  
  const workspaceForLayout = useCallback((workspace: Workspace): Workspace => {
    if (!resizing || resizing.workspaceId !== workspace.id) return workspace;
    const previewSizes = computeSplitSizesFromDelta(resizing, resizePreviewDelta);
    return patchWorkspaceSplitSizes(workspace, resizing.splitId, previewSizes);
  }, [resizePreviewDelta, resizing]);

  const workspaceRectsCacheRef = useRef(new Map<string, {
    root: Workspace['root'];
    previewKey: string;
    width: number;
    height: number;
    rects: Record<string, WorkspaceRect>;
  }>());

  const workspaceRectsById = useMemo(
      () => {
        const map = new Map<string, Record<string, WorkspaceRect>>();
        const liveWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
        for (const workspaceId of workspaceRectsCacheRef.current.keys()) {
          if (!liveWorkspaceIds.has(workspaceId)) {
            workspaceRectsCacheRef.current.delete(workspaceId);
          }
        }

        for (const workspace of workspaces) {
          if (shouldKeepHiddenWorkspaceLaidOut(workspace)) {
            if (workspace.id === activeWorkspace?.id) continue;
            const layoutWorkspace = workspaceForLayout(workspace);
            const previewKey = resizing?.workspaceId === workspace.id
              ? `${resizing.workspaceId}:${resizing.splitId}:${resizePreviewDelta}`
              : 'still';
            const cached = workspaceRectsCacheRef.current.get(workspace.id);
            const cachedSizeIsUsable = !!cached && cached.width > 0 && cached.height > 0;
            if (
              cached
              && cached.root === layoutWorkspace.root
              && cached.previewKey === previewKey
              && (cachedSizeIsUsable || workspaceArea.width <= 0 || workspaceArea.height <= 0)
            ) {
              map.set(workspace.id, cached.rects);
              continue;
            }

            const layoutSize = cachedSizeIsUsable
              ? { width: cached.width, height: cached.height }
              : workspaceArea;
            if (layoutSize.width <= 0 || layoutSize.height <= 0) continue;

            const rects = computeWorkspaceRects(layoutWorkspace, layoutSize);
            workspaceRectsCacheRef.current.set(workspace.id, {
              root: layoutWorkspace.root,
              previewKey,
              width: layoutSize.width,
              height: layoutSize.height,
              rects,
            });
            map.set(workspace.id, rects);
          }
        }

        if (!activeWorkspace) return map;

        const workspace = workspaces.find((candidate) => candidate.id === activeWorkspace.id) ?? activeWorkspace;
        const layoutWorkspace = workspaceForLayout(workspace);
        const previewKey = resizing?.workspaceId === workspace.id
          ? `${resizing.workspaceId}:${resizing.splitId}:${resizePreviewDelta}`
          : 'still';
        const cached = workspaceRectsCacheRef.current.get(workspace.id);
        if (
          cached
          && cached.root === layoutWorkspace.root
          && cached.previewKey === previewKey
          && cached.width === workspaceArea.width
          && cached.height === workspaceArea.height
        ) {
          map.set(workspace.id, cached.rects);
          return map;
        }

        const rects = computeWorkspaceRects(layoutWorkspace, workspaceArea);
        workspaceRectsCacheRef.current.set(workspace.id, {
          root: layoutWorkspace.root,
          previewKey,
          width: workspaceArea.width,
          height: workspaceArea.height,
          rects,
        });
        map.set(workspace.id, rects);
        return map;
      },
      [activeWorkspace, computeWorkspaceRects, resizePreviewDelta, resizing, shouldKeepHiddenWorkspaceLaidOut, workspaceArea, workspaceForLayout, workspaces],
    );
  
  const activeWorkspaceRects = useMemo<Record<string, WorkspaceRect>>(
      () => activeWorkspace ? workspaceRectsById.get(activeWorkspace.id) ?? {} : {},
      [activeWorkspace, workspaceRectsById]
    );
  
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
  
  const activeResizers = useMemo(
    () => collectResizers(
      activeWorkspace ? workspaceForLayout(activeWorkspace) : undefined,
      workspaceArea,
    ),
    [activeWorkspace, workspaceArea, collectResizers, workspaceForLayout],
  );
  
  const computeSplitHint = useCallback((e: DragEvent): SplitHint => {
      if (isFocusMode) return null;
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
    }, [isFocusMode, workspaceArea, activeWorkspaceRects, workspaceOverlayRef, workspaceInnerRef, workspaceOuterRef]);

  const handleWorkspaceDrop = useCallback((e: DragEvent) => {
      if (isFocusMode) return;
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
    }, [isFocusMode, computeSplitHint, setDropHint, onSetDraggingSessionId, activeWorkspace, sessions, onAddSessionToWorkspace, activeSession, onCreateWorkspaceFromSessions]);

  return {
    activeResizers,
    computeSplitHint,
    dropHint,
    findSplitNode,
    handleWorkspaceDrop,
    resizing,
    setDropHint,
    setResizing,
    setWorkspaceArea,
    workspaceArea,
    workspaceInnerRef,
    workspaceOuterRef,
    workspaceOverlayRef,
    workspaceRectsById,
  };
}
