import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface DomHarnessHandle {
  dom: JSDOM;
  window: Window & typeof globalThis;
  document: Document;
  container: HTMLDivElement;
  render: (element: React.ReactElement) => Promise<void>;
  cleanup: () => Promise<void>;
}

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "FocusEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

/**
 * Install an isolated JSDOM + React 19 createRoot environment and restore all globals on cleanup.
 */
export function createDomHarness(options: { url?: string; netcatty?: Record<string, unknown> } = {}): DomHarnessHandle {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: options.url ?? "http://localhost/",
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const previous = new Map<string, PropertyDescriptor | undefined>();

  const install = (key: string, value: unknown) => {
    if (!previous.has(key)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  install("IS_REACT_ACT_ENVIRONMENT", true);
  for (const key of DOM_GLOBALS) {
    const value = (win as Record<string, unknown>)[key];
    if (value !== undefined) {
      install(key, value);
    }
  }
  if (!(globalThis as Record<string, unknown>).ResizeObserver) {
    install("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  }
  if (options.netcatty) {
    Object.defineProperty(win, "netcatty", {
      configurable: true,
      writable: true,
      value: options.netcatty,
    });
  }

  const container = win.document.getElementById("root") as HTMLDivElement;
  let root: Root | null = null;

  return {
    dom,
    window: win,
    document: win.document,
    container,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        if (!root) {
          root = createRoot(container);
        }
        root.render(element);
      });
    },
    cleanup: async () => {
      if (root) {
        const activeRoot = root;
        root = null;
        await act(async () => {
          activeRoot.unmount();
        });
      }
      dom.window.close();
      for (const [key, descriptor] of previous.entries()) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[key];
        }
      }
    },
  };
}

/**
 * Install an in-memory localStorage mock on globalThis and return a restore function.
 */
export function installMemoryLocalStorage(initial: Record<string, string> = {}): {
  store: Map<string, string>;
  restore: () => void;
} {
  const store = new Map<string, string>(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: mockStorage,
  });

  return {
    store,
    restore: () => {
      if (previous) {
        Object.defineProperty(globalThis, "localStorage", previous);
      } else {
        delete (globalThis as Record<string, unknown>).localStorage;
      }
    },
  };
}
