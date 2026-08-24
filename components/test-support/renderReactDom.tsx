import React from "react";
import { act } from "react";
import { JSDOM } from "jsdom";

type DomEnvironment = {
  window: Window & typeof globalThis;
  document: Document;
  cleanup: () => void;
};

export function installDomEnvironment(): DomEnvironment {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div><div id=\"splash\"></div></body></html>", {
    url: "http://localhost/",
  });

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousEvent = globalThis.Event;
  const previousFocusEvent = globalThis.FocusEvent;
  const previousKeyboardEvent = globalThis.KeyboardEvent;
  const previousMouseEvent = globalThis.MouseEvent;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousDOMParser = globalThis.DOMParser;
  const previousGetComputedStyle = globalThis.getComputedStyle;

  const overrides = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    DOMParser: dom.window.DOMParser,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  } as const;

  Object.defineProperty(dom.window.document, "hasFocus", {
    configurable: true,
    value: () => true,
  });

  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  if (!dom.window.HTMLElement.prototype.attachEvent) {
    Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
  if (!dom.window.HTMLElement.prototype.detachEvent) {
    Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }

  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });

  return {
    window: dom.window as Window & typeof globalThis,
    document: dom.window.document,
    cleanup() {
      dom.window.close();
      const previousValues = {
        window: previousWindow,
        document: previousDocument,
        navigator: previousNavigator,
        HTMLElement: previousHTMLElement,
        Node: previousNode,
        Event: previousEvent,
        FocusEvent: previousFocusEvent,
        KeyboardEvent: previousKeyboardEvent,
        MouseEvent: previousMouseEvent,
        CustomEvent: previousCustomEvent,
        DOMParser: previousDOMParser,
        getComputedStyle: previousGetComputedStyle,
      } as const;
      for (const [key, value] of Object.entries(previousValues)) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value,
        });
      }
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    },
  };
}

export async function createDomRenderer(document: Document) {
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("DOM root container missing");
  }

  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  return {
    container,
    async render(node: React.ReactNode) {
      await act(async () => {
        root.render(node);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

export async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

export async function dispatchDomEvent(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

export async function runWithAct(run: () => void | Promise<void>) {
  await act(async () => {
    await run();
  });
}
