import { type DragEvent, useCallback, useMemo, useRef, useState } from 'react';

import type { TerminalSession, Workspace, WorkspaceNode } from '../../types';
import type { ResizerHandle, SplitHint, WorkspaceRect } from './TerminalLayerSupport';

interface UseTerminalWorkspaceLayoutOptions {
  activeSession: TerminalSession | undefined;
  activeWorkspace: Workspace | undefined;
  isFocusMode: boolean;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onSetDraggingSessionId: (id: string | null) => void;
  sessions: TerminalSession[];
  workspaces: Workspace[];
}

export function useTerminalWorkspaceLayout({
  activeSession,
  activeWorkspace,
  isFocusMode,
  onAddSessionToWorkspace,
  onCreateWorkspaceFromSessions,
  onSetDraggingSessionId,
  sessions,
  workspaces,
}: UseTerminalWorkspaceLayoutOptions) {
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
  
  const workspaceRectsById = useMemo(
      () => {
        const map = new Map<string, Record<string, WorkspaceRect>>();
        for (const workspace of workspaces) {
          map.set(workspace.id, computeWorkspaceRects(workspace, workspaceArea));
        }
        return map;
      },
      [computeWorkspaceRects, workspaceArea, workspaces],
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
  
  const activeResizers = useMemo(() => collectResizers(activeWorkspace, workspaceArea), [activeWorkspace, workspaceArea, collectResizers]);
  
  const computeSplitHint = (e: DragEvent): SplitHint => {
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
    };
  
  const handleWorkspaceDrop = (e: DragEvent) => {
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
    workspaceInnerRef,
    workspaceOuterRef,
    workspaceOverlayRef,
    workspaceRectsById,
  };
}
