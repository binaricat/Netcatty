import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';

export interface RemoteDesktopSnipRect {
  /** Normalized permille coordinates (0..1000) of the canvas framebuffer. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Approximate natural framebuffer pixel dimensions for user display. */
  pixelWidth: number;
  pixelHeight: number;
}

export interface SnipClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComputedSnipSelection {
  /** Visual selection box relative to the overlay element (in CSS pixels). */
  displayRect: { left: number; top: number; width: number; height: number };
  /** Normalized 0..1000 crop rect relative to the live canvas framebuffer. */
  normalizedRect: RemoteDesktopSnipRect;
}

export const MIN_SNIP_DRAG_PX = 8;

/**
 * Pure geometry helper mapping viewport drag points onto the live `<canvas>`
 * rect (handling letterboxed `fit` / `actual` / `stretch` modes) and producing
 * both overlay-relative display coordinates and 0..1000 normalized permille
 * crop coordinates.
 */
export function computeSnipSelectionRect(
  startClient: { x: number; y: number },
  currentClient: { x: number; y: number },
  overlayRect: SnipClientRect,
  canvasRect: SnipClientRect,
  naturalWidth: number,
  naturalHeight: number,
): ComputedSnipSelection | null {
  if (
    canvasRect.width <= 0 || canvasRect.height <= 0
    || naturalWidth <= 0 || naturalHeight <= 0
  ) {
    return null;
  }

  const clampX = (v: number) => Math.max(canvasRect.left, Math.min(canvasRect.left + canvasRect.width, v));
  const clampY = (v: number) => Math.max(canvasRect.top, Math.min(canvasRect.top + canvasRect.height, v));

  const x1 = clampX(startClient.x);
  const y1 = clampY(startClient.y);
  const x2 = clampX(currentClient.x);
  const y2 = clampY(currentClient.y);

  const leftClient = Math.min(x1, x2);
  const topClient = Math.min(y1, y2);
  const cssWidth = Math.abs(x2 - x1);
  const cssHeight = Math.abs(y2 - y1);

  if (cssWidth < MIN_SNIP_DRAG_PX || cssHeight < MIN_SNIP_DRAG_PX) {
    return null;
  }

  const relX = (leftClient - canvasRect.left) / canvasRect.width;
  const relY = (topClient - canvasRect.top) / canvasRect.height;
  const relW = cssWidth / canvasRect.width;
  const relH = cssHeight / canvasRect.height;

  const normX = Math.max(0, Math.min(999, Math.round(relX * 1000)));
  const normY = Math.max(0, Math.min(999, Math.round(relY * 1000)));
  const normW = Math.max(1, Math.min(1000 - normX, Math.round(relW * 1000)));
  const normH = Math.max(1, Math.min(1000 - normY, Math.round(relH * 1000)));

  const pixelWidth = Math.max(1, Math.round((normW / 1000) * naturalWidth));
  const pixelHeight = Math.max(1, Math.round((normH / 1000) * naturalHeight));

  return {
    displayRect: {
      left: leftClient - overlayRect.left,
      top: topClient - overlayRect.top,
      width: cssWidth,
      height: cssHeight,
    },
    normalizedRect: {
      x: normX,
      y: normY,
      width: normW,
      height: normH,
      pixelWidth,
      pixelHeight,
    },
  };
}

export interface RemoteDesktopSnipOverlayProps {
  /** Whether snipping mode is active. */
  open: boolean;
  /** Natural framebuffer width in pixels (used for live `W x H px` badge). */
  naturalWidth: number;
  /** Natural framebuffer height in pixels (used for live `W x H px` badge). */
  naturalHeight: number;
  /** Optional getter for the live `<canvas>` bounding rect in viewport coordinates. */
  getCanvasRect?: () => DOMRect | null;
  /** Fired on pointer release with a valid normalized `0..1000` crop rect. */
  onSelect: (rect: RemoteDesktopSnipRect) => void;
  /** Fired on Esc, right-click, or clicking the cancel button. */
  onCancel: () => void;
}

export const RemoteDesktopSnipOverlay: React.FC<RemoteDesktopSnipOverlayProps> = ({
  open,
  naturalWidth,
  naturalHeight,
  getCanvasRect,
  onSelect,
  onCancel,
}) => {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [selection, setSelection] = useState<ComputedSnipSelection | null>(null);

  useEffect(() => {
    if (!open) {
      dragStartRef.current = null;
      setSelection(null);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dragStartRef.current = null;
        setSelection(null);
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onCancel]);

  const computeFromPoints = useCallback((
    start: { x: number; y: number },
    current: { x: number; y: number },
  ): ComputedSnipSelection | null => {
    const overlayEl = overlayRef.current;
    if (!overlayEl) return null;
    const overlayRect = overlayEl.getBoundingClientRect();
    const canvasRect = getCanvasRect?.() ?? overlayRect;
    return computeSnipSelectionRect(
      start,
      current,
      overlayRect,
      canvasRect,
      naturalWidth,
      naturalHeight,
    );
  }, [getCanvasRect, naturalWidth, naturalHeight]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest('[data-snip-control="true"]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
    setSelection(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    setSelection(computeFromPoints(start, { x: event.clientX, y: event.clientY }));
  }, [computeFromPoints]);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const finalSelection = commit
      ? computeFromPoints(start, { x: event.clientX, y: event.clientY })
      : null;
    setSelection(null);
    if (commit && finalSelection) {
      onSelect(finalSelection.normalizedRect);
    }
  }, [computeFromPoints, onSelect]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      role="region"
      aria-label={t('ai.vision.snip.ariaLabel')}
      data-testid="remote-desktop-snip-overlay"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => finishDrag(e, true)}
      onPointerCancel={(e) => finishDrag(e, false)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragStartRef.current = null;
        setSelection(null);
        onCancel();
      }}
      className="absolute inset-0 z-40 overflow-hidden cursor-crosshair select-none touch-none"
    >
      {/* Dim backdrop when no selection box is active yet */}
      {!selection && (
        <div className="pointer-events-none absolute inset-0 bg-black/45" />
      )}

      {/* Bright cutout selection rectangle with surrounding dimmed mask */}
      {selection && (
        <div
          data-testid="remote-desktop-snip-selection"
          className="pointer-events-none absolute border border-primary/95 ring-1 ring-white/40"
          style={{
            left: selection.displayRect.left,
            top: selection.displayRect.top,
            width: selection.displayRect.width,
            height: selection.displayRect.height,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.50)',
          }}
        >
          <div
            data-testid="remote-desktop-snip-dimensions"
            className="absolute left-0 -top-7 whitespace-nowrap rounded bg-zinc-950/90 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white shadow-md ring-1 ring-white/15"
            style={selection.displayRect.top < 32 ? { top: 6, left: 6 } : undefined}
          >
            {selection.normalizedRect.pixelWidth} &times; {selection.normalizedRect.pixelHeight} px
          </div>
        </div>
      )}

      {/* Top instruction bar + cancel button */}
      <div
        data-snip-control="true"
        className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-zinc-950/85 px-3 py-1.5 text-[12px] text-white/90 shadow-lg backdrop-blur-sm"
      >
        <span>{t('ai.vision.snip.hint')}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          aria-label={t('ai.vision.snip.cancel')}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/15 hover:text-white cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};

export default React.memo(RemoteDesktopSnipOverlay);
