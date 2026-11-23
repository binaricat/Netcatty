import { RemoteMutationObserver, remoteId } from '@remote-dom/core/elements';
import type { HostDrawnViewEvent, JsonValue } from '@netcatty/plugin-contract';
import type { Disposable, PluginViews } from './index.js';

/** Build ordinary DOM in the isolated runtime; only validated data reaches the visible host. */
export function registerHostDomView(views: PluginViews, viewId: string, mount: (container: HTMLElement, stateScope: string) => (() => void) | void, css = ''): Disposable {
  if (css.length > 65536) throw new TypeError('Plugin CSS exceeds the view limit');
  type View = { container: HTMLDivElement; unmount: () => void; observer: RemoteMutationObserver; sequence: number; acknowledgedEvent: number; sentAck: number; poll: ReturnType<typeof setInterval>; controls: Map<string, string> };
  const instances = new Map<string, View>();
  const close = (id: string) => {
    const view = instances.get(id); if (!view) return;
    instances.delete(id); clearInterval(view.poll); view.observer.disconnect(); view.unmount(); view.container.remove();
  };
  const sendEvent = (view: View, event: HostDrawnViewEvent) => {
    const element = [...view.container.querySelectorAll('*')].find((item) => remoteId(item) === event.nodeId);
    if (!element || !(element instanceof HTMLElement)) return;
    if (event.type === 'dismiss') { element.dispatchEvent(new Event('netcatty-dismiss')); return; }
    if (event.type === 'click') {
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
    if (event.type === 'reset' && element instanceof HTMLFormElement) { element.reset(); return; }
    if (event.type === 'submit') { const action = new Event(event.type, { bubbles: true, cancelable: true }); action.preventDefault(); element.dispatchEvent(action); return; }
    if (event.type === 'keydown' || event.type === 'keyup') {
      element.dispatchEvent(new KeyboardEvent(event.type, { key: event.key ?? '', ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, bubbles: true, cancelable: true })); return;
    }
    if (event.type.startsWith('composition')) { element.dispatchEvent(new CompositionEvent(event.type, { data: event.data ?? '', bubbles: true })); return; }
    if (event.type === 'focusin' || event.type === 'focusout') { element.dispatchEvent(new FocusEvent(event.type, { bubbles: true })); return; }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element instanceof HTMLSelectElement && element.multiple && event.values) {
        for (const option of element.options) option.selected = event.values.includes(option.value);
      }
      if (!(element instanceof HTMLSelectElement && element.multiple) && event.value !== undefined && event.value.length <= 8192) {
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype
          : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, event.value);
      }
      if (element instanceof HTMLInputElement && typeof event.checked === 'boolean') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(element, event.checked);
      }
      element.dispatchEvent(new Event(event.type, { bubbles: true, cancelable: true }));
    }
  };
  const subscription = views.onDidReceiveMessage(viewId, (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.instanceId !== 'string') return;
    const id = message.instanceId;
    if (message.kind === 'host-ui.open') {
      if (instances.has(id)) return;
      const container = document.createElement('div'); document.body.appendChild(container);
      let view: View;
      const send = (mutations: readonly unknown[]) => {
        if (instances.get(id) !== view) return;
        const records = [...mutations]; const live = new Set<string>();
        for (const control of container.querySelectorAll('input,textarea,select,option')) {
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
        views.postMessage(viewId, JSON.parse(JSON.stringify({ kind: 'host-ui.update', instanceId: id, sequence: ++view.sequence, acknowledgedEvent: view.acknowledgedEvent, css, mutations: records })) as JsonValue);
      };
      const observer = new RemoteMutationObserver({
        mutate(mutations) { send(mutations); },
        call() { throw new Error('Direct host methods are unavailable'); },
      });
      view = { container, unmount: () => {}, observer, sequence: 0, acknowledgedEvent: 0, sentAck: 0, controls: new Map(), poll: setInterval(() => send([]), 50) };
      instances.set(id, view);
      observer.observe(container);
      // A valid component may render nothing; complete initial loading even when
      // React makes no DOM mutations.
      views.postMessage(viewId, { kind: 'host-ui.update', instanceId: id, sequence: ++view.sequence, css, mutations: [] });
      const mountRoot = document.createElement('div');
      mountRoot.setAttribute('style', 'min-height:100%;height:100%');
      container.appendChild(mountRoot);
      const cleanup = mount(mountRoot, typeof message.stateScope === 'string' ? message.stateScope : viewId);
      if (typeof cleanup === 'function') view.unmount = cleanup;
    } else if (message.kind === 'host-ui.close') close(id);
    else if (message.kind === 'host-ui.event') {
      const view = instances.get(id);
      if (view && message.event && typeof message.event === 'object' && !Array.isArray(message.event)) {
        const event = message.event as unknown as HostDrawnViewEvent;
        view.acknowledgedEvent = event.eventId ?? view.acknowledgedEvent;
        sendEvent(view, event);
      }
    }
  });
  return { dispose() { subscription.dispose(); for (const id of [...instances.keys()]) close(id); } };
}
