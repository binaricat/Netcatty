import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MIN_POPOVER_WIDTH = 160;
const MAX_POPOVER_WIDTH = 480;
const DEFAULT_POPOVER_WIDTH = 240;
const MIN_POPOVER_HEIGHT = 80;
const MAX_POPOVER_HEIGHT = 420;

export interface PluginViewPopoverProps {
  anchor?: string;
  anchorX?: number;
  anchorY?: number;
  width?: number;
  maxHeight?: number;
  open: boolean;
  dismiss(): void;
  children: React.ReactNode;
}

/** Geometry and dismissal belong to the host; content belongs to the plugin. */
export function PluginViewPopover({
  anchor,
  anchorX,
  anchorY,
  width: requestedWidth,
  maxHeight: requestedMaxHeight,
  open,
  dismiss,
  children,
}: PluginViewPopoverProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !marker.current) {
      setPosition(null);
      return;
    }
    const root = marker.current.getRootNode() as ShadowRoot;
    const doc = marker.current.ownerDocument;
    const win = doc.defaultView!;
    const surface = root.host instanceof win.HTMLElement
      ? root.host.closest('[data-plugin-remote-surface]')
      : null;

    const hasCursorCoords =
      typeof anchorX === 'number' && Number.isFinite(anchorX)
      && typeof anchorY === 'number' && Number.isFinite(anchorY);

    const target = anchor ? root.getElementById(anchor) : null;
    const targetEl = target instanceof win.HTMLElement ? target : null;
    if (!hasCursorCoords && !targetEl) {
      setPosition(null);
      return;
    }

    const resolveSurfaceBounds = () => {
      const vp = {
        left: 8,
        top: 8,
        right: Math.max(8, win.innerWidth - 8),
        bottom: Math.max(8, win.innerHeight - 8),
      };
      if (!surface) return vp;
      const sr = surface.getBoundingClientRect();
      if (sr.width <= 0 || sr.height <= 0) return vp;
      return {
        left: Math.max(vp.left, sr.left + 4),
        top: Math.max(vp.top, sr.top + 4),
        right: Math.min(vp.right, sr.right - 4),
        bottom: Math.min(vp.bottom, sr.bottom - 4),
      };
    };

    const update = () => {
      const clip = resolveSurfaceBounds();
      const availableW = Math.max(MIN_POPOVER_WIDTH, clip.right - clip.left);
      const availableH = Math.max(MIN_POPOVER_HEIGHT, clip.bottom - clip.top);
      const boundedMaxHeight = Math.min(
        availableH,
        Math.max(
          MIN_POPOVER_HEIGHT,
          Math.min(
            MAX_POPOVER_HEIGHT,
            typeof requestedMaxHeight === 'number' && Number.isFinite(requestedMaxHeight)
              ? Math.round(requestedMaxHeight)
              : MAX_POPOVER_HEIGHT,
          ),
        ),
      );

      let width: number;
      let rawLeft: number;
      let rawTop: number;
      let anchorTop: number;

      if (hasCursorCoords) {
        const sr = surface?.getBoundingClientRect();
        const originLeft = sr && sr.width > 0 ? sr.left : 0;
        const originTop = sr && sr.height > 0 ? sr.top : 0;
        const desiredW =
          typeof requestedWidth === 'number' && Number.isFinite(requestedWidth)
            ? requestedWidth
            : DEFAULT_POPOVER_WIDTH;
        width = Math.min(availableW, Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(desiredW))));
        rawLeft = originLeft + anchorX!;
        rawTop = originTop + anchorY! + 2;
        anchorTop = originTop + anchorY!;
      } else {
        const bounds = targetEl!.getBoundingClientRect();
        if (!bounds.width || !bounds.height) {
          setPosition(null);
          dismissRef.current();
          return;
        }
        const desiredW =
          typeof requestedWidth === 'number' && Number.isFinite(requestedWidth)
            ? requestedWidth
            : Math.min(360, Math.max(220, bounds.width));
        width = Math.min(availableW, Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(desiredW))));
        rawLeft = bounds.left;
        rawTop = bounds.bottom + 4;
        anchorTop = bounds.top;
      }

      const left = Math.max(clip.left, Math.min(rawLeft, clip.right - width));
      const measuredHeight = panel.current?.getBoundingClientRect().height || 0;
      const estimatedHeight = measuredHeight > 0 ? Math.min(measuredHeight, boundedMaxHeight) : Math.min(240, boundedMaxHeight);

      let top = rawTop;
      let effectiveMaxHeight = boundedMaxHeight;
      const spaceBelow = clip.bottom - rawTop;
      const spaceAbove = anchorTop - 4 - clip.top;

      if (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) {
        effectiveMaxHeight = Math.min(boundedMaxHeight, Math.max(MIN_POPOVER_HEIGHT, Math.floor(spaceAbove)));
        top = Math.max(clip.top, anchorTop - 4 - Math.min(estimatedHeight, effectiveMaxHeight));
      } else {
        effectiveMaxHeight = Math.min(boundedMaxHeight, Math.max(MIN_POPOVER_HEIGHT, Math.floor(spaceBelow)));
        top = Math.max(clip.top, Math.min(rawTop, clip.bottom - Math.min(estimatedHeight, effectiveMaxHeight)));
      }

      setPosition({ left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight: Math.round(effectiveMaxHeight) });
    };

    const dismissNow = () => {
      setPosition(null);
      dismissRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissNow();
        targetEl?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (targetEl && path.includes(targetEl)) return;
      if (panel.current && path.includes(panel.current)) return;
      dismissNow();
    };
    const blocked = () => [...doc.querySelectorAll('[role=dialog][aria-modal=true]:not([data-plugin-dialog])')].some((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (blocked()) {
      dismissNow();
      return;
    }

    const dialogs = new win.MutationObserver(() => {
      if (blocked()) dismissNow();
    });
    dialogs.observe(doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'hidden', 'data-state'],
    });
    const resize = new win.ResizeObserver(update);
    if (targetEl) resize.observe(targetEl);
    if (surface) resize.observe(surface);
    update();
    win.addEventListener('resize', update);
    doc.addEventListener('scroll', update, true);
    doc.addEventListener('keydown', key, true);
    doc.addEventListener('pointerdown', outside, true);
    return () => {
      dialogs.disconnect();
      resize.disconnect();
      win.removeEventListener('resize', update);
      doc.removeEventListener('scroll', update, true);
      doc.removeEventListener('keydown', key, true);
      doc.removeEventListener('pointerdown', outside, true);
    };
  }, [anchor, anchorX, anchorY, requestedWidth, requestedMaxHeight, open]);

  return (
    <>
      <span ref={marker} hidden />
      {open && position && marker.current && createPortal(
        <div
          ref={panel}
          role="region"
          aria-label="Plugin menu"
          data-plugin-view-popover=""
          className="fixed z-[45] overflow-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
            contain: 'paint',
            isolation: 'isolate',
          }}
        >
          {children}
        </div>,
        marker.current.ownerDocument.body,
      )}
    </>
  );
}
