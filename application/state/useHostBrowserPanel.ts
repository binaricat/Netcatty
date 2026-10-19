import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentBrowserThemeTokens, mountHostBrowser } from '../hostBrowser';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '../../domain/models';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { HostBrowserPanelSnapshotLayer } from '../../types/global/netcatty-bridge-sync';

function overlapsBrowser(rect: DOMRect, element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || element.closest('[hidden], [inert], [data-state="closed"]')) return false;
  const overlay = element.getBoundingClientRect();
  return overlay.width > 0 && overlay.height > 0
    && overlay.x < rect.right && overlay.right > rect.x
    && overlay.y < rect.bottom && overlay.bottom > rect.y;
}

interface BrowserPanelOptions {
  browserId: string;
  host: Host;
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts: KnownHost[];
  terminalSettings: TerminalSettings;
  isVisible: boolean;
}

export function useHostBrowserPanel(options: BrowserPanelOptions) {
  const elementRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const opened = useRef(false);
  const mountedBrowserId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [readyId, setReadyId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ browserId: string; layers: HostBrowserPanelSnapshotLayer[] } | null>(null);
  const { browserId, isVisible } = options;

  useLayoutEffect(() => {
    const bridge = netcattyBridge.get();
    let frame: number | null = null;
    let previous = '';
    let disposed = false;
    let layoutRevision = 0;
    const element = elementRef.current;
    const doc = element?.ownerDocument;
    const view = doc?.defaultView;
    const observed = new Set<Element>();
    const animations = new Map<Animation, Element>();
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        for (const [animation, target] of animations) {
          if (!target.isConnected || (!animation.pending && animation.playState !== 'running')) animations.delete(animation);
        }
        update();
        if (animations.size > 0) schedule();
      });
    };
    const trackAnimations = (target: Element) => {
      for (const animation of target.getAnimations?.() ?? []) {
        if (!animation.pending && animation.playState !== 'running') continue;
        animations.set(animation, target);
      }
    };
    const resizeObserver = isVisible && view?.ResizeObserver ? new view.ResizeObserver(schedule) : null;
    const update = () => {
      const element = elementRef.current;
      const rect = element?.getBoundingClientRect();
      // Native views sit above renderer portals. Only overlapping poppers need
      // to yield; dialogs are modal even when their content is beside the pane.
      const locked = !!document.querySelector('[data-app-lock-overlay]');
      const modal = !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
      const overlays = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper] > *',
      ));
      const covered = modal || (!!rect && overlays.some((overlay) => overlapsBrowser(rect, overlay)));
      const targets = new Set<Element>(overlays);
      for (let target: Element | null = element; target; target = target.parentElement) targets.add(target);
      for (const target of observed) {
        if (!targets.has(target)) { resizeObserver?.unobserve(target); observed.delete(target); }
      }
      for (const target of targets) {
        if (observed.has(target)) continue;
        observed.add(target);
        resizeObserver?.observe(target);
        trackAnimations(target);
      }
      const visible = isVisible && !!element?.isConnected && !!rect
        && rect.width > 0 && rect.height > 0 && !element?.closest('[inert]') && !locked;
      if (!visible) setSnapshot(null);
      const bounds = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      const theme = element && getComputedStyle(element).colorScheme === 'light' ? 'light' : 'dark';
      const themeTokens = currentBrowserThemeTokens(element ?? undefined);
      const layout: Parameters<NonNullable<NetcattyBridge['setHostBrowserPanelLayout']>>[0] = {
        browserId, visible, occluded: visible && covered, bounds, theme, themeTokens,
      };
      const next = JSON.stringify(layout);
      if (next !== previous) {
        previous = next;
        const revision = ++layoutRevision;
        void bridge?.setHostBrowserPanelLayout?.(layout).then((result) => {
          if (disposed || layoutRevision !== revision) return;
          setSnapshot(visible && covered && typeof result === 'object' ? { browserId, layers: result.layers } : null);
        }).catch(() => {});
      }
    };
    if (!isVisible) {
      setSnapshot(null);
      void bridge?.setHostBrowserPanelLayout?.({ browserId, visible: false }).catch(() => {});
      return;
    }

    // Layout, theme and portal changes coalesce into a single frame. Keep
    // following only running animations on the pane's ancestors or overlay
    // containers; unrelated spinner/cursor animations must not restart polling.
    const mutationObserver = view?.MutationObserver ? new view.MutationObserver(schedule) : null;
    if (doc) mutationObserver?.observe(doc.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'inert', 'role', 'aria-modal', 'data-state',
        'data-app-lock-overlay', 'data-radix-popper-content-wrapper', 'href', 'media', 'disabled'],
    });
    const onMotion = (event: Event) => {
      const target = event.target;
      if (!element || !view || !(target instanceof view.Element)) return;
      if (!target.contains(element) && !target.matches(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [data-app-lock-overlay], '
        + '[data-radix-popper-content-wrapper], [data-radix-popper-content-wrapper] > *',
      )) return;
      trackAnimations(target);
      schedule();
    };
    const motionEvents = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
    for (const event of motionEvents) doc?.addEventListener(event, onMotion, true);
    doc?.addEventListener('scroll', schedule, true);
    doc?.addEventListener('load', schedule, true);
    view?.addEventListener('resize', schedule);
    doc?.fonts?.addEventListener('loadingdone', schedule);
    doc?.fonts?.addEventListener('loadingerror', schedule);
    if (doc?.fonts?.status === 'loading') void doc.fonts.ready.then(schedule);
    update();
    if (animations.size > 0) schedule();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      for (const event of motionEvents) doc?.removeEventListener(event, onMotion, true);
      doc?.removeEventListener('scroll', schedule, true);
      doc?.removeEventListener('load', schedule, true);
      view?.removeEventListener('resize', schedule);
      doc?.fonts?.removeEventListener('loadingdone', schedule);
      doc?.fonts?.removeEventListener('loadingerror', schedule);
      void bridge?.setHostBrowserPanelLayout?.({ browserId, visible: false }).catch(() => {});
    };
  }, [browserId, isVisible]);

  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    setError(null);
    let cancelled = false;
    void mountHostBrowser({ ...optionsRef.current, browserId }).then(() => {
      if (mountedBrowserId.current === browserId) setReadyId(browserId);
    }).catch((reason: unknown) => {
      opened.current = false;
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [attempt, browserId, isVisible]);

  useEffect(() => {
    mountedBrowserId.current = browserId;
    return () => {
      opened.current = false;
      mountedBrowserId.current = null;
      // StrictMode replays setup immediately. Do not destroy its pending URL
      // or native browser unless the owning panel actually remains unmounted.
      queueMicrotask(() => {
        if (mountedBrowserId.current === browserId) return;
        void netcattyBridge.get()?.closeHostBrowserPanel?.(browserId).catch(() => {});
      });
    };
  }, [browserId]);

  return { elementRef, error, ready: readyId === browserId, snapshot: isVisible && snapshot?.browserId === browserId ? snapshot.layers : [],
    retry: () => setAttempt((value) => value + 1) };
}
