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

export function resolveMagnifiedChromeBorderWidth(devicePixelRatio = 1): number {
  return devicePixelRatio > 0 && devicePixelRatio < 1.5 ? 2 : 1;
}

export function snapCssRectToDevicePixels(
  left: number,
  top: number,
  right: number,
  bottom: number,
  devicePixelRatio = 1,
): { left: number; top: number; width: number; height: number } {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const snap = (value: number) => Math.round(value * dpr) / dpr;
  const snappedLeft = snap(left);
  const snappedTop = snap(top);
  const snappedRight = snap(right);
  const snappedBottom = snap(bottom);
  return {
    left: snappedLeft,
    top: snappedTop,
    width: Math.max(0, snappedRight - snappedLeft),
    height: Math.max(0, snappedBottom - snappedTop),
  };
}

export const PANE_MAGNIFICATION_DURATION_MS = 200;

export function resolvePaneMagnificationStyle(
  original: React.CSSProperties,
  magnified: boolean,
  surfaceBounds?: { left: number; top: number; width: number; height: number } | null,
  devicePixelRatio = 1,
  layoutOrigin?: { left: number; top: number; width?: number; height?: number },
): React.CSSProperties {
  // Keep the fixed overlay and transition while restoring too, so the split
  // container cannot clip the pane before it has finished shrinking.
  const transition: React.CSSProperties = surfaceBounds ? {
    transitionProperty: 'left, top, width, height',
    transitionDuration: `${PANE_MAGNIFICATION_DURATION_MS}ms`,
    transitionTimingFunction: 'ease-out',
    zIndex: 50,
  } : {};
  // Margins compensate for the containing-block switch without animating or
  // transforming the terminal and its descendants. Local split offsets then
  // keep the same viewport origin when fixed positioning starts or ends.
  const fixedOrigin: React.CSSProperties = {
    position: 'fixed',
    ...(layoutOrigin ? {
      marginLeft: `${layoutOrigin.left}px`,
      marginTop: `${layoutOrigin.top}px`,
    } : {}),
  };
  if (!magnified) {
    if (!surfaceBounds) return original;
    // Percentage lengths must keep using the layout parent when fixed.
    const resolveLength = (value: string | number | undefined, parentSize?: number) => {
      if (typeof value === 'number') return `${value}px`;
      if (typeof value === 'string' && value.endsWith('%') && parentSize !== undefined) {
        return `${parseFloat(value) * parentSize / 100}px`;
      }
      return value;
    };
    return {
      ...original,
      ...transition,
      ...fixedOrigin,
      left: resolveLength(original.left, layoutOrigin?.width),
      top: resolveLength(original.top, layoutOrigin?.height),
      width: resolveLength(original.width, layoutOrigin?.width),
      height: resolveLength(original.height, layoutOrigin?.height),
    };
  }
  if (surfaceBounds) {
    const snapped = snapCssRectToDevicePixels(
      surfaceBounds.left + 12,
      surfaceBounds.top + 12,
      surfaceBounds.left + surfaceBounds.width - 12,
      surfaceBounds.top + surfaceBounds.height - 12,
      devicePixelRatio,
    );
    return {
      ...transition,
      ...fixedOrigin,
      left: `${snapped.left - (layoutOrigin?.left ?? 0)}px`,
      top: `${snapped.top - (layoutOrigin?.top ?? 0)}px`,
      width: `${snapped.width}px`,
      height: `${snapped.height}px`,
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
