import type React from 'react';

export type PaneMagnificationState = 'unavailable' | 'focusable' | 'focused';

export type PaneMagnificationController = {
  getState: () => PaneMagnificationState;
  toggle: () => boolean;
  focus: () => boolean;
  restore: () => boolean;
};

export type PaneMagnificationTarget =
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'side-panel'; paneId: string; tool: string };

export function isPaneMagnificationSelectionValid(
  selection: { tabId: string; target: PaneMagnificationTarget },
  terminalPanes: Array<{ tabId: string; sessionId: string }>,
  sidePanelPanes: Array<{ tabId: string; paneId: string }>,
): boolean {
  return selection.target.kind === 'terminal'
    ? terminalPanes.some((pane) => (
      pane.tabId === selection.tabId && pane.sessionId === selection.target.sessionId
    ))
    : sidePanelPanes.some((pane) => (
      pane.tabId === selection.tabId && pane.paneId === selection.target.paneId
    ));
}

export function resolvePaneMagnificationCandidate({
  tabId,
  terminalSessionIds,
  focusedSessionId,
  sidePanelPanes,
  lastTarget,
  current,
}: {
  tabId: string;
  terminalSessionIds: string[];
  focusedSessionId?: string | null;
  sidePanelPanes: Array<{ id: string; tool: string }>;
  lastTarget?: PaneMagnificationTarget;
  current: { tabId: string; target: PaneMagnificationTarget } | null;
}): { target: PaneMagnificationTarget; focused: boolean } | null {
  if (terminalSessionIds.length + sidePanelPanes.length < 2) return null;
  const targetIsValid = (target: PaneMagnificationTarget) => (
    target.kind === 'terminal'
      ? terminalSessionIds.includes(target.sessionId)
      : sidePanelPanes.some((pane) => pane.id === target.paneId)
  );
  if (current?.tabId === tabId && targetIsValid(current.target)) {
    return { target: current.target, focused: true };
  }
  if (lastTarget && targetIsValid(lastTarget)) {
    if (lastTarget.kind === 'side-panel') {
      return { target: lastTarget, focused: false };
    }
    if (focusedSessionId && terminalSessionIds.includes(focusedSessionId)) {
      return {
        target: { kind: 'terminal', sessionId: focusedSessionId },
        focused: false,
      };
    }
    return { target: lastTarget, focused: false };
  }
  const terminalSessionId = focusedSessionId && terminalSessionIds.includes(focusedSessionId)
    ? focusedSessionId
    : terminalSessionIds[0];
  if (terminalSessionId) {
    return { target: { kind: 'terminal', sessionId: terminalSessionId }, focused: false };
  }
  const pane = sidePanelPanes[0];
  return pane
    ? { target: { kind: 'side-panel', paneId: pane.id, tool: pane.tool }, focused: false }
    : null;
}

export function getAvailablePaneMagnificationController(
  controllers: Array<PaneMagnificationController | null | undefined>,
): PaneMagnificationController | null {
  return controllers.find((controller) => (
    controller && controller.getState() !== 'unavailable'
  )) ?? null;
}

export function getPaneMagnificationShortcutLabel(
  keyBindings: Array<{ id: string; mac: string; pc: string }> | undefined,
  hotkeyScheme: 'mac' | 'pc' | 'disabled' | undefined,
): string {
  if (!keyBindings || !hotkeyScheme || hotkeyScheme === 'disabled') return '';
  const binding = keyBindings.find((entry) => entry.id === 'toggle-pane-zoom');
  return (hotkeyScheme === 'mac' ? binding?.mac : binding?.pc)?.replace(/ \+ /g, '+') ?? '';
}

export function resolvePaneMagnificationStyle(
  original: React.CSSProperties,
  magnified: boolean,
  surfaceBounds?: { left: number; top: number; width: number; height: number } | null,
): React.CSSProperties {
  if (!magnified) return original;
  if (surfaceBounds) {
    return {
      position: 'fixed',
      left: `${surfaceBounds.left + 12}px`,
      top: `${surfaceBounds.top + 12}px`,
      width: `${Math.max(0, surfaceBounds.width - 24)}px`,
      height: `${Math.max(0, surfaceBounds.height - 24)}px`,
      zIndex: 50,
    };
  }
  return {
    left: '12px',
    top: '12px',
    width: 'calc(100% - 24px)',
    height: 'calc(100% - 24px)',
    zIndex: 50,
  };
}

export function resolveTwoPaneMagnificationStyle(
  side: 'left' | 'right',
  wide: boolean,
  magnified: boolean,
): React.CSSProperties {
  if (magnified) {
    return {
      left: '12px',
      top: '12px',
      width: 'calc(100% - 24px)',
      height: 'calc(100% - 24px)',
      zIndex: 50,
    };
  }
  if (wide) {
    return {
      left: side === 'left' ? '0%' : '50%',
      top: '0%',
      width: '50%',
      height: '100%',
      zIndex: 10,
    };
  }
  return {
    left: '0%',
    top: side === 'left' ? '0%' : '50%',
    width: '100%',
    height: '50%',
    zIndex: 10,
  };
}
