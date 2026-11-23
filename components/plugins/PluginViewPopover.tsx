import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Geometry and dismissal belong to the host; content belongs to the plugin. */
export function PluginViewPopover({ anchor, open, dismiss, children }: {
  anchor: string; open: boolean; dismiss(): void; children: React.ReactNode;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(dismiss); dismissRef.current = dismiss;
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !marker.current) { setPosition(null); return; }
    const root = marker.current.getRootNode() as ShadowRoot;
    const target = root.getElementById(anchor);
    if (!(target instanceof marker.current.ownerDocument.defaultView!.HTMLElement)) return;
    const doc = target.ownerDocument; const win = doc.defaultView!;
    const update = () => {
      const bounds = target.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { setPosition(null); dismissRef.current(); return; }
      const width = Math.min(360, Math.max(220, bounds.width), win.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(bounds.left, win.innerWidth - width - 8)), top: Math.max(8, Math.min(bounds.bottom + 4, win.innerHeight - 248)), width });
    };
    const dismissNow = () => { setPosition(null); dismissRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissNow(); target.focus(); } };
    const outside = (event: PointerEvent) => { if (!event.composedPath().includes(target) && (!panel.current || !event.composedPath().includes(panel.current))) dismissNow(); };
    const blocked = () => [...doc.querySelectorAll('[role=dialog][aria-modal=true]:not([data-plugin-dialog])')].some((dialog) => {
      const rect = dialog.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
    });
    if (blocked()) { dismissNow(); return; }
    const dialogs = new win.MutationObserver(() => { if (blocked()) dismissNow(); });
    dialogs.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'hidden', 'data-state'] });
    const resize = new win.ResizeObserver(update); resize.observe(target); update();
    win.addEventListener('resize', update); doc.addEventListener('scroll', update, true);
    doc.addEventListener('keydown', key, true); doc.addEventListener('pointerdown', outside, true);
    return () => { dialogs.disconnect(); resize.disconnect(); win.removeEventListener('resize', update); doc.removeEventListener('scroll', update, true); doc.removeEventListener('keydown', key, true); doc.removeEventListener('pointerdown', outside, true); };
  }, [anchor, open]);
  return <><span ref={marker} hidden />{open && position && marker.current && createPortal(
    <div ref={panel} role="region" aria-label="Plugin menu" data-plugin-view-popover className="fixed z-[45] overflow-hidden rounded-lg border border-border bg-background shadow-xl" style={{ ...position, height: 240, maxHeight: 'calc(100vh - 16px)', contain: 'paint', isolation: 'isolate' }}>{children}</div>, marker.current.ownerDocument.body,
  )}</>;
}
