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

test("self-heal adopts live X/Y when echo wraps instead of double-counting", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    // Prompt ends at col 8; four pending cells predict X=12 on a 10-col
    // terminal (wraps to col 2 / row 1). When echo lands there, Math.max
    // on X alone would keep 12 and paint the ghost on row 2.
    term.cols = 10;
    term.buffer.active.cursorX = 8;
    term.buffer.active.cursorY = 0;
    term.buffer.active.baseY = 0;
    term.buffer.active.getLine = () => ({
      translateToString: () => "$       ",
    });
    addon.activate(term as never);
    addon.show("abcdefghij", "abcd");
    const ghost = ghostElement();
    assert.ok(ghost);
    // Predicted wrap: col 2 on row 1 → left 18px, top 18px.
    assert.equal(ghost.style.left, "18px");
    assert.equal(ghost.style.top, "18px");

    term.buffer.active.cursorX = 2;
    term.buffer.active.cursorY = 1;
    term.buffer.active.getLine = () => ({
      isWrapped: true,
      translateToString: () => "abcd",
    });
    fireRender();

    assert.equal(ghost.style.left, "18px");
    assert.equal(ghost.style.top, "18px");
  } finally {
    restoreDocument();
  }
});

test("self-heal adopts live X when a bottom-row wrap scrolls instead of changing Y", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    // Bottom-row prediction: prompt at col 8 + 4 pending cells → X=12.
    // Echo scrolls the buffer so Y stays on the last row while live X
    // becomes the normalized wrap column (2). Math.max would keep 12 and
    // paint the ghost one row below the visible screen.
    term.cols = 10;
    term.rows = 24;
    term.buffer.active.cursorX = 8;
    term.buffer.active.cursorY = 23;
    term.buffer.active.baseY = 0;
    term.buffer.active.getLine = () => ({
      translateToString: () => "$       ",
    });
    addon.activate(term as never);
    addon.show("abcdefghij", "abcd");
    const ghost = ghostElement();
    assert.ok(ghost);
    // Pre-echo: col 2 on predicted row 24 → top 24*18.
    assert.equal(ghost.style.left, "18px");
    assert.equal(ghost.style.top, "432px");

    term.buffer.active.cursorX = 2;
    term.buffer.active.cursorY = 23;
    term.buffer.active.getLine = () => ({
      isWrapped: true,
      translateToString: () => "abcd",
    });
    fireRender();

    assert.equal(ghost.style.left, "18px");
    assert.equal(ghost.style.top, "414px");
  } finally {
    restoreDocument();
  }
});

test("anchors ghost after wide pre-echo input when the line has not echoed yet", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    term.buffer.active.baseY = 0;
    term.buffer.active.getLine = () => ({
      translateToString: () => "$ ",
    });
    addon.activate(term as never);
    // Live cursor still at the prompt; typed "部署" is only in the keystroke buffer.
    addon.show("部署脚本", "部署");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, "脚本");
    // cursorX=2 + 4 wide cells → column 6 → left 54px.
    assert.equal(ghost.style.left, "54px");
  } finally {
    restoreDocument();
  }
});

test("anchors ghost using only the unechoed suffix after a partial shell echo", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    // Shell has echoed "$ doc"; buffered input is still the full "docker".
    term.buffer.active.cursorX = 5;
    term.buffer.active.baseY = 0;
    term.buffer.active.getLine = () => ({
      translateToString: () => "$ doc",
    });
    addon.activate(term as never);
    addon.show("docker compose", "docker");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, " compose");
    // Unechoed "ker" is 3 cells → column 8 → left 72px (not 5+6=11).
    assert.equal(ghost.style.left, "72px");
  } finally {
    restoreDocument();
  }
});

test("anchors ghost by cell columns when the prompt is a multi-code-unit emoji", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    // Family ZWJ emoji is many UTF-16 units but only 2 terminal cells.
    // A UTF-16 slice(0, cursorX) would stop inside the emoji and treat the
    // fully-echoed "docker" as unechoed, shifting the ghost right.
    const emoji = "👨‍👩‍👧‍👦";
    const cells: Array<{ chars: string; width: number }> = [
      { chars: emoji, width: 2 },
      { chars: " ", width: 1 },
      { chars: "$", width: 1 },
      { chars: " ", width: 1 },
      ...Array.from("docker", (ch) => ({ chars: ch, width: 1 })),
    ];
    const totalCols = cells.reduce((sum, cell) => sum + cell.width, 0);
    term.buffer.active.cursorX = totalCols;
    term.buffer.active.baseY = 0;
    term.buffer.active.getLine = () => ({
      translateToString: (
        _trimRight?: boolean,
        startColumn = 0,
        endColumn = totalCols,
      ) => {
        let col = 0;
        let text = "";
        for (const cell of cells) {
          if (col >= endColumn) break;
          if (col >= startColumn) text += cell.chars;
          col += cell.width;
        }
        return text;
      },
    });
    addon.activate(term as never);
    addon.show("docker compose", "docker");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, " compose");
    // Fully echoed → stay at live cursor (11 cells → 99px), not 11+6.
    assert.equal(ghost.style.left, "99px");
  } finally {
    restoreDocument();
  }
});

test("does not overshoot the ghost when the echoed command already wrapped", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    // cols=10, prompt "$ " + "docker com" wraps; cursor sits on the
    // continuation row after a fully-echoed "docker compose".
    // Physical rows: "$ docker c" | "ompose|"
    term.cols = 10;
    term.buffer.active.baseY = 0;
    term.buffer.active.cursorY = 1;
    term.buffer.active.cursorX = 6;
    const lines: Record<number, { isWrapped?: boolean; text: string }> = {
      0: { text: "$ docker c" },
      1: { isWrapped: true, text: "ompose" },
    };
    term.buffer.active.getLine = (y: number) => {
      const row = lines[y];
      if (!row) return undefined;
      return {
        isWrapped: row.isWrapped,
        translateToString: (
          _trimRight?: boolean,
          startColumn?: number,
          endColumn?: number,
        ) => {
          if (startColumn !== undefined && endColumn !== undefined) {
            return row.text.padEnd(endColumn).slice(startColumn, endColumn);
          }
          return row.text;
        },
      };
    };
    addon.activate(term as never);
    addon.show("docker compose up", "docker compose");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, " up");
    // Fully echoed across the wrap → anchor stays at live cursor (col 6),
    // not liveX + full input width.
    assert.equal(ghost.style.left, "54px");
    assert.equal(ghost.style.top, "18px");
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

test("applyKeystroke: printable char trims ghost tail when buffer is unreliable (issue #906)", () => {
  // Repro for issue #906: after Tab passes to shell and the typed-buffer
  // is flagged unreliable, the ghost addon's currentInput is the only
  // source of truth for what the user has typed since the last show().
  // Without applyKeystroke, line 798's reliability gate prevents
  // adjustToInput from firing and the ghost retains its show-time tail
  // — when the next keystroke advances the cursor, the stale tail
  // overlaps the just-typed glyph (e.g., typing 't' after 'systemctl s'
  // makes the screen read 'systemctl sttop firewalld').
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("systemctl stop firewalld", "systemctl s");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, "top firewalld");

    addon.applyKeystroke("t");

    // Ghost tail must shrink by exactly one char so when the shell
    // echoes 't', the next visible glyph after the cursor is 'o', not
    // 't' (which would render as 'sttop').
    assert.equal(ghost.textContent, "op firewalld");
    assert.equal(addon.isActive(), true);
  } finally {
    restoreDocument();
  }
});

test("applyKeystroke: backspace re-grows ghost tail by one char", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("docker", "doc");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, "ker");

    addon.applyKeystroke("\x7f");

    assert.equal(ghost.textContent, "cker");
  } finally {
    restoreDocument();
  }
});

test("applyKeystroke: Ctrl+W word-erases trailing word from currentInput", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    // Mid-suggestion: user has typed two words; Ctrl+W should drop the
    // tail word and let the ghost regrow to cover what was erased.
    addon.show("git commit -m wip", "git com");
    const ghost = ghostElement();
    assert.ok(ghost);
    assert.equal(ghost.textContent, "mit -m wip");

    addon.applyKeystroke("\x17");

    // The same /\s*\S+\s*$/ regex used by handleInput consumes the
    // leading whitespace too, so "git com" → "git"; the ghost regrows
    // to cover the now-uncovered leading space + remainder.
    assert.equal(ghost.textContent, " commit -m wip");
  } finally {
    restoreDocument();
  }
});

test("applyKeystroke: hides ghost when next char diverges from suggestion", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("docker", "do");
    const ghost = ghostElement();
    assert.ok(ghost);

    // 'x' breaks the prefix invariant — ghost must hide immediately so
    // a → -accept after this point can't pull a stale tail onto a line
    // that no longer matches the suggestion.
    addon.applyKeystroke("x");

    assert.equal(ghost.style.display, "none");
    assert.equal(addon.isActive(), false);
  } finally {
    restoreDocument();
  }
});

test("applyKeystroke: ignores non-typing data (escape sequences, control codes)", () => {
  // Escape sequences and other control codes are routed through
  // clearState() in handleInput, not propagated to the ghost — but we
  // want applyKeystroke to be a safe no-op if accidentally called with
  // them (defense in depth).
  const restoreDocument = installFakeDocument();
  const { term, ghostElement } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("docker", "do");
    const ghost = ghostElement();
    assert.ok(ghost);
    const tailBefore = ghost.textContent;

    addon.applyKeystroke("\x1b[A"); // up-arrow escape sequence
    addon.applyKeystroke("\x01");    // Ctrl+A
    addon.applyKeystroke("");         // empty

    assert.equal(ghost.textContent, tailBefore);
    assert.equal(addon.isActive(), true);
  } finally {
    restoreDocument();
  }
});

test("hides the ghost on render when the device echoed untracked input (#1013)", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    // We believe only "network in" is typed; suggestion is the full command.
    addon.show("network interface show", "network in");
    assert.equal(addon.isActive(), true);

    // The real line shows MORE than we tracked: a bastion host echoed the
    // next char ("t") that our client-side buffer never recorded.
    const line = "ecOS# network int";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = line.length;
    active.getLine = () => ({ translateToString: () => line });

    fireRender();

    assert.equal(addon.isActive(), false);
    assert.equal(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("hides the ghost when TopsecOS-style backspace leaves stale text after the cursor (#1060)", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    // The user deleted back from "system..." to "syst", so the tracked
    // input is shorter and the ghost regrows to "em license show".
    addon.show("system license show", "syst");
    assert.equal(addon.isActive(), true);

    // TopsecOS devices shown in #1060 leave the old suffix visible after
    // the cursor while processing Backspace, so the real buffer looks like:
    // TopsecOS# syst|em license show
    const beforeCursor = "TopsecOS# syst";
    const line = `${beforeCursor}em license show`;
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => line });

    fireRender();

    assert.equal(addon.isActive(), false);
    assert.equal(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("hides the ghost when only the deleted prefix remains after the cursor (#1060)", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "syst");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "TopsecOS# syst";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor}em` });

    fireRender();

    assert.equal(addon.isActive(), false);
    assert.equal(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("hides the ghost when TopsecOS-style backspace leaves stale text after empty input (#1060)", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "TopsecOS# ";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor}system license show` });

    fireRender();

    assert.equal(addon.isActive(), false);
    assert.equal(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("hides the ghost when stale text is followed by right-side status text (#1060)", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "syst");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "TopsecOS# syst";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor}em     12:34 ok` });

    fireRender();

    assert.equal(addon.isActive(), false);
    assert.equal(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("hides the ghost when a stale argument suffix starts with a space (#1060)", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "system");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "TopsecOS# system";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor} license show` });

    fireRender();

    assert.equal(addon.isActive(), false);
    assert.equal(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("keeps the ghost when unrelated right-side prompt text is visible", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "syst");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "host# syst";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor}     12:34 ok` });

    fireRender();

    assert.equal(addon.isActive(), true);
    assert.notEqual(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("keeps the ghost when only right-side spacing overlaps a space-prefixed suffix", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "system");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "host# system";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor}     12:34 ok` });

    fireRender();

    assert.equal(addon.isActive(), true);
    assert.notEqual(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});

test("keeps the ghost when adjacent right-side text only shares the first character", () => {
  const restoreDocument = installFakeDocument();
  const { term, ghostElement, fireRender } = createFakeTerm();
  const addon = new GhostTextAddon();

  try {
    addon.activate(term as never);
    addon.show("system license show", "syst");
    assert.equal(addon.isActive(), true);

    const beforeCursor = "host# syst";
    const active = term.buffer.active as Record<string, unknown>;
    active.baseY = 0;
    active.cursorX = beforeCursor.length;
    active.getLine = () => ({ translateToString: () => `${beforeCursor}error` });

    fireRender();

    assert.equal(addon.isActive(), true);
    assert.notEqual(ghostElement()?.style.display, "none");
  } finally {
    addon.dispose();
    restoreDocument();
  }
});
