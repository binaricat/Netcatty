import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LazyLoadBoundary } from '../ui/lazy-load-boundary';
import { PluginViewPopover } from './PluginViewPopover';
import { createPortal } from 'react-dom';
import { validatePluginRemoteTree } from '@/domain/pluginRemoteTreePolicy.cjs';
import { validatePluginStylesheet } from '@/domain/pluginViewStylePolicy.cjs';

type RemoteNode = { id: string; type: 3; data: string } | { id: string; type: 8; data: string } | {
  id: string; type: 1; element: string; attributes: Record<string, string>; children: RemoteNode[];
};
export type PluginSurfaceEvent = import('@netcatty/plugin-contract').HostDrawnViewEvent;
const ATTRIBUTE_NAMES: Record<string, string> = { class: 'className', for: 'htmlFor', readonly: 'readOnly', tabindex: 'tabIndex', maxlength: 'maxLength', minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', autocomplete: 'autoComplete' };
const BOOLEAN_ATTRIBUTES = new Set(['checked', 'disabled', 'readonly', 'required', 'multiple', 'selected', 'open']);

const SurfaceContext = createContext<{ css: string; onEvent(event: PluginSurfaceEvent): void; depth: number }>({ css: '', onEvent: () => {}, depth: 0 });
const ResourceLoader = createContext<((path: string) => Promise<string>) | undefined>(undefined);

function RemoteElement({ node, settled }: { node: RemoteNode; settled: boolean }): React.ReactNode {
  const attrs = node.type === 1 ? node.attributes : {};
  const surface = useContext(SurfaceContext);
  const loadImage = useContext(ResourceLoader);
  const imagePath = node.type === 1 && node.element === 'img' ? attrs.src?.slice(6) : undefined;
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false; setImageUrl(undefined);
    if (imagePath && loadImage) void loadImage(imagePath).then((url) => { if (!cancelled) setImageUrl(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [imagePath, loadImage]);
  const remoteSelection = JSON.stringify(node.type === 1 && node.element === 'select'
    ? node.children.filter((child) => child.type === 1 && child.element === 'option' && Object.hasOwn(child.attributes, 'selected')).map((child) => child.type === 1 ? child.attributes.value ?? '' : '') : []);
  const [localSelection, setLocalSelection] = useState<string[]>(() => JSON.parse(remoteSelection));
  useEffect(() => { if (settled) setLocalSelection(JSON.parse(remoteSelection)); }, [remoteSelection, settled]);
  const remoteValue = attrs.value;
  const remoteChecked = Object.hasOwn(attrs, 'checked');
  const [localValue, setLocalValue] = useState(remoteValue ?? '');
  const [localChecked, setLocalChecked] = useState(remoteChecked);
  useEffect(() => { if (settled && remoteValue !== undefined) setLocalValue(remoteValue); }, [remoteValue, settled]);
  useEffect(() => { if (settled) setLocalChecked(remoteChecked); }, [remoteChecked, settled]);
  if (node.type === 3) return node.data;
  if (node.type === 8) return null;
  if (attrs['data-plugin-popover'] === 'true') return surface.depth < 1 ? <PluginViewPopover anchor={attrs['data-plugin-anchor'] ?? ''} open={Object.hasOwn(attrs, 'open')} dismiss={() => surface.onEvent({ nodeId: node.id, type: 'dismiss' })}><PluginRemoteSurface tree={{ children: node.children }} css={surface.css} onEvent={surface.onEvent} settled={settled} loadImage={loadImage} depth={surface.depth + 1} /></PluginViewPopover> : null;
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
  if (node.element === 'img') props.src = imageUrl;
  if (node.element === 'form') props.onSubmit = (event: React.FormEvent) => event.preventDefault();
  if (['input', 'select', 'textarea'].includes(node.element)) {
    if (node.element === 'select' && Object.hasOwn(attrs, 'multiple')) props.value = localSelection;
    else if (remoteValue !== undefined) props.value = localValue;
    props.autoComplete = 'off';
    if (node.element === 'input' && ['checkbox', 'radio'].includes(attrs.type ?? '')) props.checked = localChecked;
    props.onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setLocalValue(event.currentTarget.value);
      if (event.currentTarget instanceof event.currentTarget.ownerDocument.defaultView!.HTMLSelectElement && event.currentTarget.multiple) setLocalSelection([...event.currentTarget.selectedOptions].map((option) => option.value));
      if (event.currentTarget instanceof event.currentTarget.ownerDocument.defaultView!.HTMLInputElement) setLocalChecked(event.currentTarget.checked);
    };
  }
  return React.createElement(node.element, props, ...(node.element === 'textarea' && remoteValue !== undefined ? [] : node.children).map((child) => <RemoteElement key={child.id} node={child} settled={settled} />));
}

/** Host-owned DOM, kept inside a closed shadow root and a clipped stacking context. */
export function PluginRemoteSurface({ tree, css, onEvent, settled = true, loadImage, depth = 0 }: { depth?: number; tree: unknown; css: string; settled?: boolean; loadImage?(path: string): Promise<string>; onEvent(event: PluginSurfaceEvent): void }) {
  const checked = useMemo(() => {
    try {
      validatePluginRemoteTree(tree);
      return { tree: tree as { children: RemoteNode[] }, css: validatePluginStylesheet(css) };
    } catch { return null; }
  }, [tree, css]);
  if (!checked) return <p role="alert" className="p-4 text-sm text-destructive">Unable to display plugin view.</p>;
  return <LazyLoadBoundary name="Plugin view" fallback={<p role="alert" className="p-4 text-sm text-destructive">Unable to display plugin view.</p>}><SurfaceContext.Provider value={{ css: checked.css, onEvent, depth }}><ResourceLoader.Provider value={loadImage}><ValidatedPluginRemoteSurface tree={checked.tree} css={checked.css} onEvent={onEvent} settled={settled} /></ResourceLoader.Provider></SurfaceContext.Provider></LazyLoadBoundary>;
}

function ValidatedPluginRemoteSurface({ tree, css, onEvent, settled }: { settled: boolean; tree: { children: RemoteNode[] }; css: string; onEvent(event: PluginSurfaceEvent): void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onEventRef = useRef(onEvent); onEventRef.current = onEvent;
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The same DOM node can be mounted twice in React Strict Mode.
    const root = shadowRef.current ?? host.attachShadow({ mode: 'closed' });
    shadowRef.current = root;
    setShadow(root);
  }, []);
  useEffect(() => {
    if (!shadow) return;
    const listener = (event: Event) => {
      const target = event.target;
      const view = shadow.ownerDocument.defaultView;
      if (!view || !(target instanceof view.HTMLElement) || !['click', 'input', 'change', 'keydown', 'keyup', 'focusin', 'focusout', 'compositionstart', 'compositionupdate', 'compositionend', 'submit', 'reset'].includes(event.type)) return;
      // Closed-shadow events hide their editable target from window capture.
      if (event.type === 'focusin') hostRef.current?.toggleAttribute('data-plugin-editing', target.matches('input, textarea, select, [contenteditable]'));
      if (event.type === 'focusout') hostRef.current?.removeAttribute('data-plugin-editing');
      if (event.type === 'submit') event.preventDefault();
      const nodeId = target.dataset.netcattyRemoteNode;
      if (!nodeId) return;
      const value = target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement || target instanceof view.HTMLSelectElement ? target.value : undefined;
      const values = target instanceof view.HTMLSelectElement && target.multiple ? [...target.selectedOptions].map((option) => option.value) : undefined;
      const checkedValue = target instanceof view.HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? target.checked : undefined;
      if (value !== undefined && value.length > 8192) return;
      const keyboard = event instanceof view.KeyboardEvent && event.key.length <= 64
        ? { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey } : {};
      onEventRef.current({ nodeId, type: event.type as PluginSurfaceEvent['type'], ...(value === undefined ? {} : { value }), ...(checkedValue === undefined ? {} : { checked: checkedValue }), ...keyboard, ...(values ? { values } : {}), ...(event instanceof view.CompositionEvent ? { data: event.data.slice(0, 8192) } : {}) });
    };
    for (const event of ['click', 'input', 'change', 'keydown', 'keyup', 'focusin', 'focusout', 'compositionstart', 'compositionupdate', 'compositionend', 'submit', 'reset']) shadow.addEventListener(event, listener, true);
    return () => { for (const event of ['click', 'input', 'change', 'keydown', 'keyup', 'focusin', 'focusout', 'compositionstart', 'compositionupdate', 'compositionend', 'submit', 'reset']) shadow.removeEventListener(event, listener, true); };
  }, [shadow]);
  return <div className="h-full w-full min-h-0 min-w-0 overflow-hidden [contain:paint] isolate relative" data-plugin-remote-surface>
    <div ref={hostRef} className="h-full min-h-0 overflow-auto [container-type:inline-size]" />
    {shadow && createPortal(<><style>{css}</style>{tree.children.map((node) => <RemoteElement key={node.id} node={node} settled={settled} />)}</>, shadow)}
  </div>;
}
