import test from "node:test";
import assert from "node:assert/strict";

import { GhostTextAddon } from "./autocomplete/GhostTextAddon.ts";

type RenderListener = () => void;
type ResizeListener = () => void;

class FakeElement {
  public readonly style: Record<string, string> = {};
  public textContent = "";
  public className = "";
  public children: FakeElement[] = [];

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, referenceNode: FakeElement | null): FakeElement {
    if (!referenceNode) {
      this.children.push(child);
      return child;
    }
    const index = this.children.indexOf(referenceNode);
    if (index < 0) {
      this.children.push(child);
      return child;
    }
    this.children.splice(index, 0, child);
    return child;
  }

  remove(): void {
    // No-op for tests.
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === ".xterm-screen") {
      return this.children.find((child) => child.className === "xterm-screen") ?? null;
    }
    return null;
  }
}

function installFakeDocument(): () => void {
  const previousDocument = globalThis.document;
  const fakeDocument = {
    createElement() {
      return new FakeElement();
    },
  } as unknown as Document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  return () => {
    if (previousDocument === undefined) {
      delete (globalThis as { document?: Document }).document;
      return;
    }
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  };
}

function createFakeTerm() {
  const renderListeners: RenderListener[] = [];
  const resizeListeners: ResizeListener[] = [];
  const element = new FakeElement();
  const screen = new FakeElement();
  screen.className = "xterm-screen";
  element.appendChild(screen);

  const term = {
    element,
    options: {
      fontSize: 14,
      fontFamily: "monospace",
    },
    buffer: {
      active: {
        cursorX: 2,
        cursorY: 0,
      },
    },
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              width: 9,
              height: 18,
            },
          },
        },
      },
    },
    onRender(listener: RenderListener) {
      renderListeners.push(listener);
      return {
        dispose() {
          const index = renderListeners.indexOf(listener);
          if (index >= 0) renderListeners.splice(index, 1);
        },
      };
    },
    onResize(listener: ResizeListener) {
      resizeListeners.push(listener);
      return {
        dispose() {
          const index = resizeListeners.indexOf(listener);
          if (index >= 0) resizeListeners.splice(index, 1);
        },
      };
    },
  };

  return {
    term,
    ghostElement: () => screen.children[0]?.children[0] ?? null,
    fireRender() {
      for (const listener of [...renderListeners]) listener();
    },
  };
}

test("shifts ghost to predicted cursor column as matching input is typed", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("docker", "do");

    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.style.display, "block");
    assert.equal(ghost.textContent, "cker");
    // show() anchored at cursorX=2, cell width=9 → left=18.
    assert.equal(ghost.style.left, "18px");

    addon.adjustToInput("doc");

    // After one matching char, the ghost predicts the cursor has moved
    // to column 3 and trims "c" from the tail so the next char starts
    // where the echo will land. Not waiting for xterm's render keeps
    // ghost + real input aligned across SSH echo latency.
    assert.equal(ghost.style.display, "block");
    assert.equal(ghost.textContent, "ker");
    assert.equal(ghost.style.left, "27px");
    assert.equal(addon.getGhostText(), "ker");
  } finally {
    restoreDocument();
  }
});

test("hides ghost immediately when input no longer matches suggestion", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("docker", "do");

    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.style.display, "block");

    addon.adjustToInput("dox");

    assert.equal(ghost.style.display, "none");
    assert.equal(ghost.textContent, "");
    assert.equal(addon.isActive(), false);
  } finally {
    restoreDocument();
  }
});
