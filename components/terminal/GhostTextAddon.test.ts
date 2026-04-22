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
    cols: 80,
    rows: 24,
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

test("walks the anchor column backwards on backspace so the ghost re-aligns", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("docker", "do");

    const ghost = ghostElement();
    assert.ok(ghost);

    addon.adjustToInput("doc");
    assert.equal(ghost.textContent, "ker");
    assert.equal(ghost.style.left, "27px");

    // Backspace below the anchor input — the ghost should shift *left*,
    // not stay pinned at the show-time anchor column. Pinning would
    // leave a visual gap between the real cursor and the ghost.
    addon.adjustToInput("d");
    assert.equal(ghost.textContent, "ocker");
    // anchor was cursorX=2 captured at show(); "d" is 1 char below
    // anchorInputLength=2 → predicted cursor column = 1.
    assert.equal(ghost.style.left, "9px");

    // Backspace past the anchor back to empty: left is clamped at 0.
    addon.adjustToInput("");
    assert.equal(ghost.textContent, "docker");
    assert.equal(ghost.style.left, "0px");
  } finally {
    restoreDocument();
  }
});

test("advances the anchor by two cells when a CJK glyph is typed", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    // Suggestion starts with a CJK char so the prefix-match survives
    // the next keystroke.
    addon.show("你好世界", "");
    const ghost = ghostElement();
    assert.ok(ghost);
    // show() anchored at cursorX=2. Input length 0 → delta 0 → left=18.
    assert.equal(ghost.style.left, "18px");

    addon.adjustToInput("你");

    // One CJK char = 2 cells. Predicted col = 2 + 2 = 4 → left 36px.
    assert.equal(ghost.textContent, "好世界");
    assert.equal(ghost.style.left, "36px");
  } finally {
    restoreDocument();
  }
});

test("wraps the ghost to the next row when the predicted column crosses cols", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    // Shrink the terminal to 10 cols to keep the math obvious. Anchor at
    // col 8 with 5 ASCII chars to type → predicted col = 13, which should
    // wrap to col 3 of row 1.
    term.cols = 10;
    term.buffer.active.cursorX = 8;
    addon.activate(term as never);
    addon.show("abcdefghij", "ab");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.style.top, "0px");

    addon.adjustToInput("abcde");

    // Predicted col = 8 + (5-2) = 11 → wraps to col 1 on next row.
    // cellWidth=9, cellHeight=18.
    assert.equal(ghost.textContent, "fghij");
    assert.equal(ghost.style.left, "9px");
    assert.equal(ghost.style.top, "18px");
  } finally {
    restoreDocument();
  }
});

test("self-heals a stale anchor on render while no adjustToInput has fired", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    // show() captures cursorX=2 — simulate this firing during the
    // keystroke→echo gap by later advancing the live cursor and
    // verifying the ghost anchor snaps to the echoed position.
    addon.show("docker", "do");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.style.left, "18px");

    term.buffer.active.cursorX = 5;
    fireRender();

    // Input hasn't moved from the show-time baseline, so updatePosition
    // re-reads live cursor: new left = 5 * 9 = 45px.
    assert.equal(ghost.style.left, "45px");
  } finally {
    restoreDocument();
  }
});

test("wraps the ghost to the previous row when deletion crosses a row boundary", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    term.cols = 10;
    term.buffer.active.cursorX = 1;
    term.buffer.active.cursorY = 1;
    addon.activate(term as never);
    // Anchored at row 1 col 1 with 5 chars already typed.
    addon.show("abcdefghij", "abcde");
    const ghost = ghostElement();
    assert.ok(ghost);

    // Backspace back to 2 chars — delta = -3 across a row boundary.
    addon.adjustToInput("ab");

    // targetCol = 1 - 3 = -2 → col = 8 (wrapped) on row 0.
    assert.equal(ghost.textContent, "cdefghij");
    assert.equal(ghost.style.left, "72px");
    assert.equal(ghost.style.top, "0px");
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
