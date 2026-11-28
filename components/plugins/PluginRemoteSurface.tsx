import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LazyLoadBoundary } from '../ui/lazy-load-boundary';
import { PluginViewPopover } from './PluginViewPopover';
import { PluginSplitPane } from './primitives/PluginSplitPane';
import { parseWidgetPropsJson, PluginSlottedWidget, type SlottedWidgetKind } from './primitives/PluginWidgetRenderer';
import { matchWorkbenchShortcut } from './primitives/shortcuts';
import type { PluginSplitPaneWidgetProps } from './primitives/types';
import { createPortal } from 'react-dom';
import { isValidatedPluginRemoteTree } from '../../application/state/pluginRemoteTree';
import { validatePluginRemoteTree } from '@/domain/pluginRemoteTreePolicy.cjs';
import { validatePluginStylesheet } from '@/domain/pluginViewStylePolicy.cjs';

type RemoteElementNode = {
  id: string; type: 1; element: string; attributes: Record<string, string>; children: RemoteNode[];
};
type RemoteNode = { id: string; type: 3; data: string } | { id: string; type: 8; data: string } | RemoteElementNode;

export type PluginSurfaceEvent = import('@netcatty/plugin-contract').HostDrawnViewEvent;

const MAX_EVENT_VALUE_LENGTH = 131072;
const SCROLL_THROTTLE_MS = 60;
const SURFACE_EVENTS = [
  'click', 'dblclick', 'contextmenu',
  'input', 'change',
  'keydown', 'keyup',
  'focusin', 'focusout',
  'compositionstart', 'compositionupdate', 'compositionend',
  'submit', 'reset',
  'scroll',
] as const;
const SURFACE_EVENT_SET = new Set<string>(SURFACE_EVENTS);
const SLOTTED_WIDGET_KINDS = new Set<string>(['code-editor', 'data-grid', 'er-canvas', 'metric-chart', 'bi-chart']);

const ATTRIBUTE_NAMES: Record<string, string> = { class: 'className', for: 'htmlFor', readonly: 'readOnly', tabindex: 'tabIndex', maxlength: 'maxLength', minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', autocomplete: 'autoComplete' };
const BOOLEAN_ATTRIBUTES = new Set(['checked', 'disabled', 'readonly', 'required', 'multiple', 'selected', 'open']);
const preventFormSubmit = (event: React.FormEvent) => event.preventDefault();

const SurfaceContext = createContext<{
  css: string;
  onEvent(event: PluginSurfaceEvent): void;
  depth: number;
  shadowHost: HTMLDivElement | null;
}>({ css: '', onEvent: () => {}, depth: 0, shadowHost: null });

function remoteText(nodes: RemoteNode[]): string {
  return nodes.map((node) => (node.type === 3 ? node.data : node.type === 1 ? remoteText(node.children) : '')).join('');
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const ResourceLoader = createContext<((path: string) => Promise<string>) | undefined>(undefined);

function buildRemoteElementProps(node: RemoteElementNode): Record<string, unknown> {
  const props: Record<string, unknown> = { 'data-netcatty-remote-node': node.id };
  let inlineStyle: string | undefined;
  for (const [name, value] of Object.entries(node.attributes)) {
    if (name === 'src' || (node.element === 'option' && name === 'selected')) continue;
    if (name === 'style') { inlineStyle = value; continue; }
    if (name === 'data-netcatty-remote-node') continue;
    props[ATTRIBUTE_NAMES[name] ?? name] = BOOLEAN_ATTRIBUTES.has(name) ? true : value;
  }
  // The policy validated this declaration list before this component rendered.
  props.ref = (el: HTMLElement | null) => { if (el) { if (inlineStyle === undefined) el.removeAttribute('style'); else el.setAttribute('style', inlineStyle); } };
  if (node.element === 'form') props.onSubmit = preventFormSubmit;
  return props;
}

const RemotePopoverElement = memo(function RemotePopoverElement({ node, settled }: { node: RemoteElementNode; settled: boolean }): React.ReactNode {
  const surface = useContext(SurfaceContext);
  const loadImage = useContext(ResourceLoader);
  if (surface.depth >= 1) return null;
  const attrs = node.attributes;
  return (
    <PluginViewPopover
      anchor={attrs['data-plugin-anchor'] ?? ''}
      anchorX={parseOptionalNumber(attrs['data-plugin-anchor-x'])}
      anchorY={parseOptionalNumber(attrs['data-plugin-anchor-y'])}
      width={parseOptionalNumber(attrs['data-plugin-popover-width'])}
      maxHeight={parseOptionalNumber(attrs['data-plugin-popover-max-height'])}
      open={Object.hasOwn(attrs, 'open')}
      dismiss={() => surface.onEvent({ nodeId: node.id, type: 'dismiss' })}
    >
      <PluginRemoteSurface
        tree={{ children: node.children }}
        css={surface.css}
        onEvent={surface.onEvent}
        settled={settled}
        loadImage={loadImage}
        depth={surface.depth + 1}
      />
    </PluginViewPopover>
  );
});

const RemoteSplitPaneElement = memo(function RemoteSplitPaneElement({ node, settled }: { node: RemoteElementNode; settled: boolean }): React.ReactNode {
  const { onEvent } = useContext(SurfaceContext);
  const rawWidgetProps = node.attributes['data-plugin-widget-props'];
  const parsed = useMemo(
    () => parseWidgetPropsJson<PluginSplitPaneWidgetProps>(rawWidgetProps),
    [rawWidgetProps],
  );
  const elementChildren = node.children.filter((child) => child.type === 1 || (child.type === 3 && child.data.length > 0));
  const firstChild = elementChildren[0] ? renderRemoteNode(elementChildren[0], settled) : null;
  const secondChild = elementChildren[1] ? renderRemoteNode(elementChildren[1], settled) : null;
  const emit = useCallback(
    (widgetEvent: string, detail?: Record<string, unknown>) => {
      onEvent({
        nodeId: node.id,
        type: 'widget',
        widgetEvent,
        detail: detail as PluginSurfaceEvent['detail'],
      });
    },
    [onEvent, node.id],
  );
  return (
    <PluginSplitPane
      {...parsed}
      nodeId={node.id}
      className={node.attributes.class}
      inlineStyle={node.attributes.style}
      firstChild={firstChild}
      secondChild={secondChild}
      onWidgetEvent={emit}
    />
  );
});

const RemoteSlottedWidgetElement = memo(function RemoteSlottedWidgetElement({ node, kind }: { node: RemoteElementNode; kind: SlottedWidgetKind }): React.ReactNode {
  const { onEvent, shadowHost } = useContext(SurfaceContext);
  const slotName = `nc-widget-${node.id}`;
  const emit = useCallback(
    (widgetEvent: string, detail?: Record<string, unknown>) => {
      onEvent({
        nodeId: node.id,
        type: 'widget',
        widgetEvent,
        detail: detail as PluginSurfaceEvent['detail'],
      });
    },
    [onEvent, node.id],
  );

  const wrapperProps = buildRemoteElementProps(node);
  const origRef = wrapperProps.ref as ((el: HTMLElement | null) => void) | undefined;
  const hasExplicitStyle = Object.hasOwn(node.attributes, 'style');
  wrapperProps.ref = (el: HTMLElement | null) => {
    origRef?.(el);
    if (el && !hasExplicitStyle) {
      el.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden');
    }
  };

  return (
    <>
      {React.createElement(
        'div',
        wrapperProps,
        React.createElement('slot', { name: slotName, style: { display: 'contents' } }),
      )}
      {shadowHost && createPortal(
        <div
          slot={slotName}
          data-plugin-widget-host={kind}
          data-plugin-widget-node={node.id}
          className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <PluginSlottedWidget
            kind={kind}
            rawProps={node.attributes['data-plugin-widget-props']}
            onWidgetEvent={emit}
          />
        </div>,
        shadowHost,
      )}
    </>
  );
});

const resolvedImageCache = new WeakMap<(path: string) => Promise<string>, Map<string, string>>();
const IMAGE_RETRY_DELAYS_MS = [150, 400, 1000] as const;
const TRANSPARENT_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function getCachedImageUrl(loader: ((path: string) => Promise<string>) | undefined, imagePath: string | undefined): string | undefined {
  if (!loader || !imagePath) return undefined;
  return resolvedImageCache.get(loader)?.get(imagePath);
}

function setCachedImageUrl(loader: (path: string) => Promise<string>, imagePath: string, url: string) {
  let map = resolvedImageCache.get(loader);
  if (!map) {
    map = new Map();
    resolvedImageCache.set(loader, map);
  }
  if (map.size >= 256) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(imagePath, url);
}

const RemoteImageElement = memo(function RemoteImageElement({ node }: { node: RemoteElementNode }): React.ReactNode {
  const loadImage = useContext(ResourceLoader);
  const imagePath = node.attributes.src?.slice(6);
  const [imageUrl, setImageUrl] = useState<string | undefined>(() => getCachedImageUrl(loadImage, imagePath));
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cached = getCachedImageUrl(loadImage, imagePath);
    if (cached) {
      setImageUrl(cached);
      return () => { cancelled = true; };
    }
    setImageUrl(undefined);
    if (imagePath && loadImage) {
      const attemptLoad = (attempt: number) => {
        void loadImage(imagePath).then((url) => {
          if (cancelled) return;
          setCachedImageUrl(loadImage, imagePath, url);
          setImageUrl(url);
        }).catch(() => {
          if (cancelled) return;
          const delay = IMAGE_RETRY_DELAYS_MS[attempt];
          if (delay !== undefined) {
            retryTimer = setTimeout(() => { if (!cancelled) attemptLoad(attempt + 1); }, delay);
          }
        });
      };
      attemptLoad(0);
    }
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [imagePath, loadImage]);
  const props = buildRemoteElementProps(node);
  if (imageUrl) {
    props.src = imageUrl;
  } else {
    // Use a transparent 1x1 placeholder while loading so Chromium never flashes
    // a broken-image icon or raw alt text before the rasterized asset arrives.
    props.src = TRANSPARENT_PLACEHOLDER_SRC;
    props.alt = '';
    props['data-plugin-image-loading'] = 'true';
  }
  return React.createElement('img', props);
});

const RemoteSelectElement = memo(function RemoteSelectElement({ node, settled }: { node: RemoteElementNode; settled: boolean }): React.ReactNode {
  const attrs = node.attributes;
  const isMultiple = Object.hasOwn(attrs, 'multiple');
  const remoteSelection = isMultiple
    ? JSON.stringify(node.children.filter((child) => child.type === 1 && child.element === 'option' && Object.hasOwn(child.attributes, 'selected')).map((child) => child.type === 1 ? child.attributes.value ?? remoteText(child.children).replace(/[\t\n\f\r ]+/g, ' ').trim() : ''))
    : '[]';
  const [localSelection, setLocalSelection] = useState<string[]>(() => (isMultiple ? JSON.parse(remoteSelection) : []));
  useEffect(() => { if (settled && isMultiple) setLocalSelection(JSON.parse(remoteSelection)); }, [isMultiple, remoteSelection, settled]);
  const remoteValue = attrs.value;
  const [localValue, setLocalValue] = useState(remoteValue ?? '');
  useEffect(() => { if (settled && remoteValue !== undefined) setLocalValue(remoteValue); }, [remoteValue, settled]);
  const props = buildRemoteElementProps(node);
  if (isMultiple) props.value = localSelection;
  else if (remoteValue !== undefined) props.value = localValue;
  props.autoComplete = 'off';
  props.onChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalValue(event.currentTarget.value);
    if (event.currentTarget.multiple) setLocalSelection([...event.currentTarget.selectedOptions].map((option) => option.value));
  };
  return React.createElement('select', props, ...node.children.map((child) => renderRemoteNode(child, settled)));
});

const RemoteInputElement = memo(function RemoteInputElement({ node, settled }: { node: RemoteElementNode; settled: boolean }): React.ReactNode {
  const attrs = node.attributes;
  const remoteValue = attrs.value ?? (node.element === 'textarea' ? remoteText(node.children) : undefined);
  const remoteChecked = Object.hasOwn(attrs, 'checked');
  const [localValue, setLocalValue] = useState(remoteValue ?? '');
  const [localChecked, setLocalChecked] = useState(remoteChecked);
  useEffect(() => { if (settled && remoteValue !== undefined) setLocalValue(remoteValue); }, [remoteValue, settled]);
  useEffect(() => { if (settled) setLocalChecked(remoteChecked); }, [remoteChecked, settled]);
  const props = buildRemoteElementProps(node);
  if (remoteValue !== undefined) props.value = localValue;
  props.autoComplete = 'off';
  if (node.element === 'input' && ['checkbox', 'radio'].includes(attrs.type ?? '')) props.checked = localChecked;
  props.onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setLocalValue(event.currentTarget.value);
    if (event.currentTarget instanceof event.currentTarget.ownerDocument.defaultView!.HTMLInputElement) setLocalChecked(event.currentTarget.checked);
  };
  // React treats textarea text specially; do not wrap it in components.
  return React.createElement(node.element, props);
});

const RemotePlainElement = memo(function RemotePlainElement({ node, settled }: { node: RemoteElementNode; settled: boolean }): React.ReactNode {
  const props = buildRemoteElementProps(node);
  // React treats option text specially; do not wrap it in components.
  if (node.element === 'option') return React.createElement(node.element, props, remoteText(node.children));
  return React.createElement(node.element, props, ...node.children.map((child) => renderRemoteNode(child, settled)));
});

function renderRemoteNode(node: RemoteNode, settled: boolean): React.ReactNode {
  if (node.type === 3) return node.data;
  if (node.type === 8) return null;
  if (node.attributes['data-plugin-popover'] === 'true') return <RemotePopoverElement key={node.id} node={node} settled={settled} />;
  const widgetKind = node.attributes['data-plugin-widget'];
  if (widgetKind === 'split-pane') return <RemoteSplitPaneElement key={node.id} node={node} settled={settled} />;
  if (widgetKind && SLOTTED_WIDGET_KINDS.has(widgetKind)) {
    return <RemoteSlottedWidgetElement key={node.id} node={node} kind={widgetKind as SlottedWidgetKind} />;
  }
  if (node.element === 'img') return <RemoteImageElement key={node.id} node={node} />;
  if (node.element === 'select') return <RemoteSelectElement key={node.id} node={node} settled={settled} />;
  if (node.element === 'input' || node.element === 'textarea') return <RemoteInputElement key={node.id} node={node} settled={settled} />;
  return <RemotePlainElement key={node.id} node={node} settled={settled} />;
}

function readSelectionRange(
  target: HTMLElement,
  view: Window & typeof globalThis,
): { selectionStart: number; selectionEnd: number } | undefined {
  const isTextInput =
    target instanceof view.HTMLTextAreaElement
    || (target instanceof view.HTMLInputElement && ['text', 'search', 'url', 'tel', 'password', ''].includes(target.type));
  if (!isTextInput) return undefined;
  try {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end)) {
      return {
        selectionStart: Math.max(0, Math.min(MAX_EVENT_VALUE_LENGTH, Math.floor(start))),
        selectionEnd: Math.max(0, Math.min(MAX_EVENT_VALUE_LENGTH, Math.floor(end))),
      };
    }
  } catch {
    // Non-selectable input types throw InvalidStateError.
  }
  return undefined;
}

/** Host-owned DOM, kept inside a closed shadow root and a clipped stacking context. */
export function PluginRemoteSurface({ tree, css, onEvent, settled = true, loadImage, depth = 0 }: { depth?: number; tree: unknown; css: string; settled?: boolean; loadImage?(path: string): Promise<string>; onEvent(event: PluginSurfaceEvent): void }) {
  const checkedTree = useMemo(() => {
    if (isValidatedPluginRemoteTree(tree)) return tree as { children: RemoteNode[] };
    try {
      validatePluginRemoteTree(tree);
      return tree as { children: RemoteNode[] };
    } catch { return null; }
  }, [tree]);
  const checkedCss = useMemo(() => {
    try {
      return validatePluginStylesheet(css);
    } catch { return null; }
  }, [css]);
  if (!checkedTree || checkedCss === null) return <p role="alert" className="p-4 text-sm text-destructive">Unable to display plugin view.</p>;
  return (
    <LazyLoadBoundary name="Plugin view" fallback={<p role="alert" className="p-4 text-sm text-destructive">Unable to display plugin view.</p>}>
      <ResourceLoader.Provider value={loadImage}>
        <ValidatedPluginRemoteSurface tree={checkedTree} css={checkedCss} onEvent={onEvent} settled={settled} depth={depth} />
      </ResourceLoader.Provider>
    </LazyLoadBoundary>
  );
}

const SHADOW_BASE_SCROLLBAR_CSS = [
  '*::-webkit-scrollbar{width:6px;height:6px}',
  '*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{background:transparent}',
  '*::-webkit-scrollbar-thumb{min-height:28px;border:1px solid transparent;border-radius:999px;background-color:transparent;background-clip:content-box}',
  '*:hover::-webkit-scrollbar-thumb{background-color:hsl(var(--muted-foreground) / 0.24)}',
  '*::-webkit-scrollbar-thumb:hover{background-color:hsl(var(--muted-foreground) / 0.45)}',
].join('');

function ValidatedPluginRemoteSurface({ tree, css, onEvent, settled, depth }: { settled: boolean; depth: number; tree: { children: RemoteNode[] }; css: string; onEvent(event: PluginSurfaceEvent): void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onEventRef = useRef(onEvent); onEventRef.current = onEvent;
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [shadowHost, setShadowHost] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The same DOM node can be mounted twice in React Strict Mode.
    const root = shadowRef.current ?? host.attachShadow({ mode: 'closed' });
    shadowRef.current = root;
    setShadow(root);
    setShadowHost(host);
  }, []);

  const surfaceContextValue = useMemo(
    () => ({ css, onEvent, depth, shadowHost }),
    [css, onEvent, depth, shadowHost],
  );

  useEffect(() => {
    if (!shadow) return;
    const scrollTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const pendingScroll = new Map<string, PluginSurfaceEvent>();

    const flushScroll = (nodeId: string) => {
      scrollTimers.delete(nodeId);
      const evt = pendingScroll.get(nodeId);
      if (evt) {
        pendingScroll.delete(nodeId);
        onEventRef.current(evt);
      }
    };

    const listener = (event: Event) => {
      const target = event.target;
      const view = shadow.ownerDocument.defaultView;
      if (!view || !(target instanceof view.HTMLElement) || !SURFACE_EVENT_SET.has(event.type)) return;

      // Closed-shadow events hide their editable target from window capture.
      if (event.type === 'focusin') {
        hostRef.current?.toggleAttribute(
          'data-plugin-editing',
          target.matches('input, textarea, select, [contenteditable]') || Boolean(target.closest('.monaco-editor')),
        );
      }
      if (event.type === 'focusout') hostRef.current?.removeAttribute('data-plugin-editing');

      // Internal events inside slotted host-rendered widgets are handled by the widget itself.
      if (target.closest('[data-plugin-widget-host]')) return;

      if (event.type === 'submit') event.preventDefault();
      if (event.type === 'contextmenu') event.preventDefault();
      if (event.type === 'keydown' && event instanceof view.KeyboardEvent) {
        const sc = matchWorkbenchShortcut(event, { includeUndoRedo: false });
        if (sc === 'mod+k' || sc === 'mod+s') {
          event.preventDefault();
        }
      }

      const nodeId = target.dataset.netcattyRemoteNode
        ?? (event.type === 'keydown' ? (shadow.querySelector('[data-netcatty-remote-node]') as HTMLElement | null)?.dataset.netcattyRemoteNode : undefined);
      if (!nodeId) return;

      if (event.type === 'scroll') {
        const scrollEvent: PluginSurfaceEvent = {
          nodeId,
          type: 'scroll' as PluginSurfaceEvent['type'],
          scrollTop: Math.max(0, Math.round(target.scrollTop)),
          scrollLeft: Math.max(0, Math.round(target.scrollLeft)),
          clientHeight: Math.max(0, Math.round(target.clientHeight)),
          clientWidth: Math.max(0, Math.round(target.clientWidth)),
        };
        pendingScroll.set(nodeId, scrollEvent);
        if (!scrollTimers.has(nodeId)) {
          scrollTimers.set(nodeId, setTimeout(() => flushScroll(nodeId), SCROLL_THROTTLE_MS));
        }
        return;
      }

      const value = target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement || target instanceof view.HTMLSelectElement ? target.value : undefined;
      const values = target instanceof view.HTMLSelectElement && target.multiple ? [...target.selectedOptions].map((option) => option.value) : undefined;
      const checkedValue = target instanceof view.HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? target.checked : undefined;
      if (value !== undefined && value.length > MAX_EVENT_VALUE_LENGTH) return;

      const keyboard = event instanceof view.KeyboardEvent && event.key.length <= 64
        ? { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey }
        : {};

      let pointerCoords: { x: number; y: number } | undefined;
      if ((event.type === 'dblclick' || event.type === 'contextmenu') && event instanceof view.MouseEvent) {
        const rect = (surfaceRef.current ?? hostRef.current)?.getBoundingClientRect();
        pointerCoords = {
          x: Math.round(rect ? event.clientX - rect.left : event.clientX),
          y: Math.round(rect ? event.clientY - rect.top : event.clientY),
        };
      }

      const selection =
        event.type === 'input' || event.type === 'change' || event.type === 'keyup' || event.type === 'keydown'
          ? readSelectionRange(target, view)
          : undefined;

      onEventRef.current({
        nodeId,
        type: event.type as PluginSurfaceEvent['type'],
        ...(value === undefined ? {} : { value }),
        ...(checkedValue === undefined ? {} : { checked: checkedValue }),
        ...keyboard,
        ...(pointerCoords ?? {}),
        ...(selection ?? {}),
        ...(values ? { values } : {}),
        ...(event instanceof view.CompositionEvent ? { data: event.data.slice(0, 8192) } : {}),
      });
    };

    for (const event of SURFACE_EVENTS) shadow.addEventListener(event, listener, true);

    // When a full-bleed plugin view is visible and focus sits on document.body (e.g.
    // right after tab switch or drawer close), forward global Cmd/Ctrl+K / Cmd/Ctrl+S
    // into the plugin so its Command Palette and Save shortcuts work reliably.
    const view = shadow.ownerDocument.defaultView;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (depth !== 0 || event.defaultPrevented) return;
      const surfaceEl = surfaceRef.current;
      if (!surfaceEl || !surfaceEl.closest('[data-plugin-chrome="full-bleed"]')) return;
      const rect = surfaceEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const doc = surfaceEl.ownerDocument;
      const hasHostModal = [...doc.querySelectorAll('[role=dialog][aria-modal=true]:not([data-plugin-dialog])')].some((dialog) => {
        const r = dialog.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (hasHostModal) return;
      const active = doc.activeElement;
      const focusInsideHostChrome = active
        && active !== doc.body
        && active !== doc.documentElement
        && !surfaceEl.contains(active)
        && !active.closest?.('[data-plugin-view-slot]');
      if (focusInsideHostChrome) return;
      const sc = matchWorkbenchShortcut(event, { includeUndoRedo: false });
      if (sc !== 'mod+k' && sc !== 'mod+s') return;
      const rootNodeId = (shadow.querySelector('[data-netcatty-remote-node]') as HTMLElement | null)?.dataset.netcattyRemoteNode;
      if (!rootNodeId) return;
      event.preventDefault();
      onEventRef.current({
        nodeId: rootNodeId,
        type: 'keydown',
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
    };
    view?.addEventListener('keydown', onWindowKeyDown, false);

    return () => {
      view?.removeEventListener('keydown', onWindowKeyDown, false);
      for (const timer of scrollTimers.values()) clearTimeout(timer);
      scrollTimers.clear();
      pendingScroll.clear();
      for (const event of SURFACE_EVENTS) shadow.removeEventListener(event, listener, true);
    };
  }, [shadow, depth]);

  const baseStyleElement = useMemo(() => <style>{SHADOW_BASE_SCROLLBAR_CSS}</style>, []);
  const pluginStyleElement = useMemo(() => <style>{css}</style>, [css]);

  return (
    <SurfaceContext.Provider value={surfaceContextValue}>
      <div ref={surfaceRef} className="h-full w-full min-h-0 min-w-0 overflow-hidden [contain:paint] isolate relative" data-plugin-remote-surface>
        <div ref={hostRef} className="h-full min-h-0 overflow-auto [container-type:inline-size] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/25" />
        {shadow && createPortal(<>{baseStyleElement}{pluginStyleElement}{tree.children.map((node) => renderRemoteNode(node, settled))}</>, shadow)}
      </div>
    </SurfaceContext.Provider>
  );
}
