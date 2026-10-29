import { createRoot } from 'react-dom/client';
import { createElement, useEffect, useRef, type ReactNode } from 'react';
import type { Disposable, PluginViews } from './index.js';
import { registerHostDomView } from './hostDom.js';

/** Author ordinary React while Netcatty owns the visible DOM. */
export function registerHostReactView(views: PluginViews, viewId: string, render: () => ReactNode, css = ''): Disposable {
  return registerHostDomView(views, viewId, (container) => {
    const root = createRoot(container); root.render(render()); return () => root.unmount();
  }, css);
}

/** A host-positioned popup with freely authored content. */
export function PluginPopover({ anchor, open, onClose, children }: { anchor: string; open: boolean; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current; if (!node) return;
    node.addEventListener('netcatty-dismiss', onClose);
    return () => node.removeEventListener('netcatty-dismiss', onClose);
  }, [onClose]);
  return createElement('div', { ref, 'data-plugin-popover': 'true', 'data-plugin-anchor': anchor, ...(open ? { open: true } : {}) }, children);
}
