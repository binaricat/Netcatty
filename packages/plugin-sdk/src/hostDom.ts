import { RemoteMutationObserver, remoteId } from '@remote-dom/core/elements';
import type { HostDrawnViewEvent, JsonValue } from '@netcatty/plugin-contract';
import type { Disposable, PluginViews } from './index.js';

type ControlPropertyTarget = {
  ctor: 'HTMLInputElement' | 'HTMLTextAreaElement' | 'HTMLSelectElement' | 'HTMLOptionElement';
  prop: string;
  kind?: 'setter' | 'method';
};

const CONTROL_PROPERTY_TARGETS: readonly ControlPropertyTarget[] = [
  { ctor: 'HTMLInputElement', prop: 'value' },
  { ctor: 'HTMLInputElement', prop: 'checked' },
  { ctor: 'HTMLInputElement', prop: 'valueAsNumber' },
  { ctor: 'HTMLInputElement', prop: 'valueAsDate' },
  { ctor: 'HTMLInputElement', prop: 'stepUp', kind: 'method' },
  { ctor: 'HTMLInputElement', prop: 'stepDown', kind: 'method' },
  { ctor: 'HTMLInputElement', prop: 'setRangeText', kind: 'method' },
  { ctor: 'HTMLTextAreaElement', prop: 'value' },
  { ctor: 'HTMLTextAreaElement', prop: 'setRangeText', kind: 'method' },
  { ctor: 'HTMLSelectElement', prop: 'value' },
  { ctor: 'HTMLSelectElement', prop: 'selectedIndex' },
  { ctor: 'HTMLOptionElement', prop: 'selected' },
];

const CONTROL_TAG_NAMES = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
const CONTROL_EVENT_TYPES = ['input', 'change', 'reset'] as const;

type ControlWatcher = {
  container: HTMLElement;
  onMutation: () => void;
};

type WindowPatchState = {
  watchers: Set<ControlWatcher>;
  restores: Array<() => void>;
};

const windowControlPatches = new WeakMap<object, WindowPatchState>();

/**
 * MutationObserver does not fire on programmatic DOM property writes such as
 * `input.value = ...`, `checkbox.checked = ...`, or `option.selected = ...`.
 * Ref-count a single prototype setter hook per Window so all mounted plugin
 * views sync async control updates immediately with zero polling, and restore
 * the original descriptors once the last view closes.
 */
function subscribeControlPropertyMutations(container: HTMLElement, onMutation: () => void): () => void {
  const win = (container.ownerDocument?.defaultView ?? globalThis) as unknown as Record<string, { prototype?: object } | undefined>;
  let state = windowControlPatches.get(win);
  if (!state) {
    state = { watchers: new Set(), restores: [] };
    const activeState = state;
    const notify = (target: Node) => {
      for (const watcher of activeState.watchers) {
        if (watcher.container.contains(target)) watcher.onMutation();
      }
    };
    for (const { ctor, prop, kind = 'setter' } of CONTROL_PROPERTY_TARGETS) {
      const prototype = win[ctor]?.prototype;
      if (!prototype) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
      if (!descriptor?.configurable) continue;
      if (kind === 'method') {
        if (typeof descriptor.value !== 'function') continue;
        const originalMethod = descriptor.value as (this: Node, ...args: unknown[]) => unknown;
        Object.defineProperty(prototype, prop, {
          ...descriptor,
          value(this: Node, ...args: unknown[]) {
            const result = originalMethod.apply(this, args);
            notify(this);
            return result;
          },
        });
      } else {
        if (!descriptor.set) continue;
        const originalSet = descriptor.set;
        Object.defineProperty(prototype, prop, {
          ...descriptor,
          set(this: Node, value: unknown) {
            originalSet.call(this, value);
            notify(this);
          },
        });
      }
      activeState.restores.push(() => {
        Object.defineProperty(prototype, prop, descriptor);
      });
    }
    windowControlPatches.set(win, state);
  }
  const watcher: ControlWatcher = { container, onMutation };
  state.watchers.add(watcher);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    state!.watchers.delete(watcher);
    if (state!.watchers.size === 0) {
      windowControlPatches.delete(win);
      for (const restore of state!.restores) restore();
      state!.restores.length = 0;
    }
  };
}

const MAX_PLUGIN_CSS_LENGTH = 131072;
const MAX_PLUGIN_EVENT_VALUE_LENGTH = 131072;

function matchShortcutFromKeyEvent(event: HostDrawnViewEvent, isTextControl: boolean): string | null {
  const key = event.key ?? '';
  if (key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) return 'escape';
  const mod = Boolean(event.metaKey || event.ctrlKey);
  if (!mod || event.altKey) return null;
  const lower = key.toLowerCase();
  if (lower === 'k' && !event.shiftKey) return 'mod+k';
  if (lower === 's' && !event.shiftKey) return 'mod+s';
  if (lower === 't' && !event.shiftKey) return 'mod+t';
  if (lower === 'w' && !event.shiftKey) return 'mod+w';
  if (!isTextControl) {
    if (lower === 'z' && event.shiftKey) return 'mod+shift+z';
    if (lower === 'z' && !event.shiftKey) return 'mod+z';
    if (lower === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'mod+shift+z';
  }
  return null;
}

/** Build ordinary DOM in the isolated runtime; only validated data reaches the visible host. */
export function registerHostDomView(views: PluginViews, viewId: string, mount: (container: HTMLElement, stateScope: string) => (() => void) | void, css = ''): Disposable {
  if (css.length > MAX_PLUGIN_CSS_LENGTH) throw new TypeError('Plugin CSS exceeds the view limit');
  type View = {
    container: HTMLDivElement;
    unmount: () => void;
    observer: RemoteMutationObserver;
    domObserver: MutationObserver;
    flushObserver: MutationObserver;
    disposeWatchers: () => void;
    elementsById: Map<string, Element>;
    controlElements: Set<Element>;
    syncElementIndex: () => void;
    scheduleFlush: () => void;
    flushScheduled: boolean;
    sequence: number;
    acknowledgedEvent: number;
    sentAck: number;
    controls: Map<string, string>;
  };
  const instances = new Map<string, View>();
  const close = (id: string) => {
    const view = instances.get(id); if (!view) return;
    instances.delete(id);
    view.disposeWatchers();
    view.flushObserver.disconnect();
    view.domObserver.disconnect();
    view.observer.disconnect();
    view.elementsById.clear();
    view.controlElements.clear();
    view.controls.clear();
    view.unmount();
    view.container.remove();
  };
  const sendEvent = (view: View, event: HostDrawnViewEvent) => {
    view.syncElementIndex();
    const element = view.elementsById.get(event.nodeId);
    if (!element || !(element instanceof HTMLElement)) return;
    const eventType = event.type;
    if (eventType === 'dismiss') { element.dispatchEvent(new Event('netcatty-dismiss')); return; }
    if (eventType === 'widget') {
      const widgetEvent = new CustomEvent('netcatty-widget-event', {
        bubbles: false,
        cancelable: true,
        detail: { widgetEvent: event.widgetEvent, detail: event.detail },
      });
      element.dispatchEvent(widgetEvent);
      if (!widgetEvent.defaultPrevented && event.widgetEvent === 'shortcut' && event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)) {
        const shortcut = (event.detail as Record<string, unknown>).shortcut;
        if (typeof shortcut === 'string') {
          element.dispatchEvent(new CustomEvent('netcatty-shortcut', { bubbles: true, detail: { shortcut } }));
        }
      }
      return;
    }
    if (eventType === 'dblclick') {
      element.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: event.x ?? 0,
        clientY: event.y ?? 0,
      }));
      return;
    }
    if (eventType === 'contextmenu') {
      element.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: event.x ?? 0,
        clientY: event.y ?? 0,
      }));
      return;
    }
    if (eventType === 'scroll') {
      try {
        if (typeof event.scrollTop === 'number') element.scrollTop = event.scrollTop;
        if (typeof event.scrollLeft === 'number') element.scrollLeft = event.scrollLeft;
      } catch { /* scroll properties may be read-only in synthetic DOM */ }
      element.dispatchEvent(new CustomEvent('scroll', {
        bubbles: false,
        detail: {
          scrollTop: event.scrollTop ?? 0,
          scrollLeft: event.scrollLeft ?? 0,
          clientHeight: event.clientHeight ?? 0,
          clientWidth: event.clientWidth ?? 0,
        },
      }));
      return;
    }
    if (eventType === 'click') {
      // The host already performed native checkbox/label behavior. Reproduce it
      // once for React's click-based change handler, without a second toggle.
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) && event.checked !== undefined) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(element, !event.checked);
      }
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) element.click();
      else {
        // The visible host performs label and form defaults. Dispatch callbacks
        // here with defaults cancelled, so one user action runs only once.
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        const preventDefault = (action: Event) => action.preventDefault();
        view.container.addEventListener('click', preventDefault, { once: true });
        try { element.dispatchEvent(click); } finally { view.container.removeEventListener('click', preventDefault); }
      }
      return;
    }
    if (eventType === 'reset' && element instanceof HTMLFormElement) { element.reset(); return; }
    if (eventType === 'submit') { const action = new Event(eventType, { bubbles: true, cancelable: true }); action.preventDefault(); element.dispatchEvent(action); return; }
    if (eventType === 'keydown' || eventType === 'keyup') {
      const isTextControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      if (isTextControl && typeof event.selectionStart === 'number' && typeof event.selectionEnd === 'number') {
        try { element.setSelectionRange(event.selectionStart, event.selectionEnd); } catch { /* selection unsupported for input type */ }
      }
      element.dispatchEvent(new KeyboardEvent(eventType, { key: event.key ?? '', ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, bubbles: true, cancelable: true }));
      if (eventType === 'keydown') {
        const shortcut = matchShortcutFromKeyEvent(event, isTextControl);
        if (shortcut) {
          element.dispatchEvent(new CustomEvent('netcatty-shortcut', { bubbles: true, detail: { shortcut } }));
        }
      }
      return;
    }
    if (eventType.startsWith('composition')) { element.dispatchEvent(new CompositionEvent(eventType, { data: event.data ?? '', bubbles: true })); return; }
    if (eventType === 'focusin' || eventType === 'focusout') { element.dispatchEvent(new FocusEvent(eventType, { bubbles: true })); return; }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element instanceof HTMLSelectElement && element.multiple && event.values) {
        for (const option of element.options) option.selected = event.values.includes(option.value);
      }
      if (!(element instanceof HTMLSelectElement && element.multiple) && event.value !== undefined && event.value.length <= MAX_PLUGIN_EVENT_VALUE_LENGTH) {
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype
          : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, event.value);
      }
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
        && typeof event.selectionStart === 'number' && typeof event.selectionEnd === 'number') {
        try { element.setSelectionRange(event.selectionStart, event.selectionEnd); } catch { /* selection unsupported for input type */ }
      }
      if (element instanceof HTMLInputElement && typeof event.checked === 'boolean') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(element, event.checked);
      }
      element.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
    }
  };
  const subscription = views.onDidReceiveMessage(viewId, (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.instanceId !== 'string') return;
    const id = message.instanceId;
    if (message.kind === 'host-ui.open') {
      if (instances.has(id)) return;
      const container = document.createElement('div'); document.body.appendChild(container);
      const elementsById = new Map<string, Element>();
      const controlElements = new Set<Element>();
      let view: View;
      const indexSubtree = (node: Node) => {
        if (!(node instanceof Element)) return;
        elementsById.set(remoteId(node), node);
        if (CONTROL_TAG_NAMES.has(node.tagName)) controlElements.add(node);
        for (const child of node.querySelectorAll('*')) {
          elementsById.set(remoteId(child), child);
          if (CONTROL_TAG_NAMES.has(child.tagName)) controlElements.add(child);
        }
      };
      const removeSubtree = (node: Node) => {
        if (!(node instanceof Element)) return;
        if (!container.contains(node)) {
          const nodeId = remoteId(node);
          if (elementsById.get(nodeId) === node) elementsById.delete(nodeId);
          controlElements.delete(node);
          view.controls.delete(nodeId);
        }
        for (const child of node.querySelectorAll('*')) {
          if (!container.contains(child)) {
            const childId = remoteId(child);
            if (elementsById.get(childId) === child) elementsById.delete(childId);
            controlElements.delete(child);
            view.controls.delete(childId);
          }
        }
      };
      const applyDomRecords = (records: MutationRecord[]) => {
        for (const record of records) {
          for (const removed of record.removedNodes) removeSubtree(removed);
          for (const added of record.addedNodes) indexSubtree(added);
        }
      };
      const domObserver = new MutationObserver((records) => {
        applyDomRecords(records);
      });
      const syncElementIndex = () => {
        const pending = domObserver.takeRecords();
        if (pending.length > 0) applyDomRecords(pending);
      };
      const send = (mutations: readonly unknown[]) => {
        if (instances.get(id) !== view) return;
        if (mutations.length > 0) syncElementIndex();
        const records = [...mutations]; const live = new Set<string>();
        for (const control of controlElements) {
          if (!container.contains(control)) {
            controlElements.delete(control);
            continue;
          }
          const node = control as HTMLInputElement;
          const nodeId = remoteId(node); live.add(nodeId);
          const properties: Record<string, string | null> = node.tagName === 'OPTION'
            ? { selected: (node as unknown as HTMLOptionElement).selected ? '' : null }
            : { value: node.value, ...(node.tagName === 'INPUT' && ['checkbox', 'radio'].includes(node.type) ? { checked: node.checked ? '' : null } : {}) };
          const signature = JSON.stringify(properties);
          if (view.controls.get(nodeId) === signature) continue;
          view.controls.set(nodeId, signature);
          for (const [name, value] of Object.entries(properties)) records.push([3, nodeId, name, value, 2]);
        }
        for (const nodeId of view.controls.keys()) if (!live.has(nodeId)) view.controls.delete(nodeId);
        if (!records.length && view.sentAck === view.acknowledgedEvent) return;
        view.sentAck = view.acknowledgedEvent;
        const safeMutations = JSON.parse(JSON.stringify(records)) as JsonValue;
        views.postMessage(viewId, {
          kind: 'host-ui.update',
          instanceId: id,
          sequence: ++view.sequence,
          acknowledgedEvent: view.acknowledgedEvent,
          css,
          mutations: safeMutations,
        } as JsonValue);
      };
      const observer = new RemoteMutationObserver({
        mutate(mutations) { send(mutations); },
        call() { throw new Error('Direct host methods are unavailable'); },
      });
      // Created after domObserver and RemoteMutationObserver so DOM MutationObserver
      // creation-order delivery guarantees structural insertions precede control flushes.
      const flushNode = document.createTextNode('');
      let flushToggle = 0;
      const flushObserver = new MutationObserver(() => {
        view.flushScheduled = false;
        if (instances.get(id) !== view) return;
        send([]);
      });
      const scheduleFlush = () => {
        if (view.flushScheduled || instances.get(id) !== view) return;
        view.flushScheduled = true;
        flushToggle ^= 1;
        flushNode.data = String(flushToggle);
      };
      const onControlEvent = () => scheduleFlush();
      for (const eventType of CONTROL_EVENT_TYPES) container.addEventListener(eventType, onControlEvent, true);
      const disposePropertyWatcher = subscribeControlPropertyMutations(container, scheduleFlush);
      const disposeWatchers = () => {
        disposePropertyWatcher();
        for (const eventType of CONTROL_EVENT_TYPES) container.removeEventListener(eventType, onControlEvent, true);
      };
      view = {
        container,
        unmount: () => {},
        observer,
        domObserver,
        flushObserver,
        disposeWatchers,
        elementsById,
        controlElements,
        syncElementIndex,
        scheduleFlush,
        flushScheduled: false,
        sequence: 0,
        acknowledgedEvent: 0,
        sentAck: 0,
        controls: new Map(),
      };
      instances.set(id, view);
      domObserver.observe(container, { childList: true, subtree: true });
      observer.observe(container);
      flushObserver.observe(flushNode, { characterData: true });
      const mountRoot = document.createElement('div');
      mountRoot.setAttribute('style', 'min-height:100%;height:100%');
      // Attach mountRoot before mount() so initial React layout effects see
      // isConnected === true and container.contains(target) === true while
      // MutationObserver microtask batching still delivers the first paint atomically.
      container.appendChild(mountRoot);
      try {
        const cleanup = mount(mountRoot, typeof message.stateScope === 'string' ? message.stateScope : viewId);
        if (typeof cleanup === 'function') view.unmount = cleanup;
      } catch (error) {
        close(id);
        throw error;
      }
      // A valid component may render nothing; complete initial loading on the
      // next microtask if mount produced no DOM mutations.
      void Promise.resolve().then(() => {
        if (instances.get(id) === view && view.sequence === 0) {
          views.postMessage(viewId, { kind: 'host-ui.update', instanceId: id, sequence: ++view.sequence, css, mutations: [] });
        }
      });
    } else if (message.kind === 'host-ui.close') close(id);
    else if (message.kind === 'host-ui.event') {
      const view = instances.get(id);
      if (view && message.event && typeof message.event === 'object' && !Array.isArray(message.event)) {
        const event = message.event as unknown as HostDrawnViewEvent;
        view.acknowledgedEvent = event.eventId ?? view.acknowledgedEvent;
        sendEvent(view, event);
        view.scheduleFlush();
      }
    }
  });
  return { dispose() { subscription.dispose(); for (const id of [...instances.keys()]) close(id); } };
}
