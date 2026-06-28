import test from "node:test";
import assert from "node:assert/strict";

import {
  clampAutocompletePopupGeometry,
  computeAutocompletePopupPlacement,
  resolveAutocompleteAnchorInViewport,
  resolveAutocompleteClampViewport,
  resolveAutocompleteCursorColumn,
  type PopupPlacementInput,
} from "./autocomplete/terminalAutocompleteLayout.ts";

const baseInput: PopupPlacementInput = {
  anchorTop: 100,
  anchorBottom: 120,
  anchorLeft: 200,
  viewportWidth: 1200,
  viewportHeight: 800,
  desiredHeight: 232,
  totalWidth: 400,
  maxHeight: 240,
  anchorGap: 8,
  viewportPadding: 8,
  expandUpwardHint: false,
};

test("renders downward with full height when there is ample room below", () => {
  const p = computeAutocompletePopupPlacement(baseInput);
  assert.equal(p.renderUpward, false);
  assert.equal(p.top, baseInput.anchorBottom + baseInput.anchorGap); // 128
  assert.equal(p.maxHeight, 240);
  // Whole popup stays within the viewport vertically.
  assert.ok(p.top + p.maxHeight <= baseInput.viewportHeight - baseInput.viewportPadding);
});

test("flips upward when the cursor sits at the very bottom of the viewport", () => {
  // Anchor line flush with the viewport bottom — classic "typing at the
  // bottom of the terminal" case from the bug report.
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorTop: 780,
    anchorBottom: 800,
  });
  assert.equal(p.renderUpward, true);
  // Bottom edge of the *rendered content* sits just above the input line.
  // p.maxHeight is only the scroll budget; actual content is min(budget,desired).
  const contentHeight = Math.min(p.maxHeight, baseInput.desiredHeight);
  assert.ok(p.top + contentHeight <= 780 - baseInput.anchorGap + 0.001);
  assert.ok(p.top >= baseInput.viewportPadding);
});

test("never lets a downward popup overflow the viewport bottom", () => {
  // A little room below but not enough for the full desired height: the popup
  // must shrink + clamp so its bottom never crosses the viewport edge.
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorTop: 600,
    anchorBottom: 620,
    desiredHeight: 232,
  });
  const bottom = p.top + p.maxHeight;
  assert.ok(
    bottom <= baseInput.viewportHeight - baseInput.viewportPadding + 0.001,
    `popup bottom ${bottom} should stay within viewport`,
  );
});

test("clamps height to the larger side when neither side fully fits", () => {
  // Short viewport: cursor in the middle, not enough above or below for 232px.
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    viewportHeight: 300,
    anchorTop: 140,
    anchorBottom: 160,
    desiredHeight: 232,
  });
  // More space below (300-160-16=124) than above (140-16=124 ~ tie) — either
  // way the rendered height must fit the chosen side and stay on-screen.
  const contentHeight = Math.min(p.maxHeight, 232);
  if (p.renderUpward) {
    assert.ok(p.top >= baseInput.viewportPadding);
    assert.ok(p.top + contentHeight <= 160 - baseInput.anchorGap + 0.001);
  } else {
    assert.ok(p.top + contentHeight <= 300 - baseInput.viewportPadding + 0.001);
  }
  assert.ok(p.maxHeight > 0);
});

test("honors the upward hint to break ties when neither side fits", () => {
  const shared = {
    ...baseInput,
    viewportHeight: 300,
    anchorTop: 150,
    anchorBottom: 170,
    desiredHeight: 232,
  };
  const withHint = computeAutocompletePopupPlacement({ ...shared, expandUpwardHint: true });
  // spaceAbove = 150-16 = 134; min(spaceBelow,80) -> spaceBelow=300-170-16=114, min=80
  // 134 >= 80 so the hint flips it upward.
  assert.equal(withHint.renderUpward, true);
});

test("clamps the left edge so the FULL assembly (with sub-dir panels) fits", () => {
  // Cursor near the right edge, popup widened by cascading sub-dir panels.
  // The whole assembly (1100px wide) must slide left to stay on-screen.
  const totalWidth = 1100; // main 400 + panels + detail
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorLeft: 1150,
    totalWidth,
  });
  assert.ok(p.left >= baseInput.viewportPadding);
  assert.ok(
    p.left + totalWidth <= baseInput.viewportWidth - baseInput.viewportPadding + 0.001,
    `right edge ${p.left + totalWidth} should stay within viewport`,
  );
});

test("pins to the left padding when the assembly is wider than the viewport", () => {
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorLeft: 600,
    viewportWidth: 500,
    totalWidth: 900,
  });
  // Can't fit no matter what — keep the primary list visible at the left edge.
  assert.equal(p.left, baseInput.viewportPadding);
});

test("does not shift left when the popup already fits at the cursor", () => {
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorLeft: 200,
    totalWidth: 400,
  });
  assert.equal(p.left, 200);
});

test("does not shift left for detail tooltips when clampWidth excludes them", () => {
  const withDetailClamp = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorLeft: 750,
    totalWidth: 684,
    clampWidth: 400,
  });
  const withFullClamp = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorLeft: 750,
    totalWidth: 684,
  });
  assert.equal(withDetailClamp.left, 750);
  assert.ok(withFullClamp.left < withDetailClamp.left);
});

test("clamps within a split terminal pane instead of the full window", () => {
  const pane = { left: 700, top: 80, width: 680, height: 520 };
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorLeft: 1180,
    totalWidth: 1100,
    clampWidth: 400,
    clampViewport: pane,
    viewportWidth: pane.width,
    viewportHeight: pane.height,
  });
  assert.ok(p.left >= pane.left + baseInput.viewportPadding);
  assert.ok(p.left + 400 <= pane.left + pane.width - baseInput.viewportPadding + 0.001);
});

test("final popup geometry clamps the actual rendered width", () => {
  const pane = { left: 700, top: 80, width: 680, height: 520 };
  const geometry = clampAutocompletePopupGeometry({
    left: 970,
    top: 180,
    width: 520,
    height: 220,
    clampViewport: pane,
    viewportPadding: 8,
  });

  assert.equal(geometry.left, 852);
  assert.ok(geometry.left >= pane.left + 8);
  assert.ok(geometry.left + 520 <= pane.left + pane.width - 8);
});

test("final popup geometry clamps the actual rendered height", () => {
  const pane = { left: 700, top: 80, width: 680, height: 520 };
  const geometry = clampAutocompletePopupGeometry({
    left: 760,
    top: 470,
    width: 360,
    height: 180,
    clampViewport: pane,
    viewportPadding: 8,
  });

  assert.equal(geometry.top, 412);
  assert.ok(geometry.top >= pane.top + 8);
  assert.ok(geometry.top + 180 <= pane.top + pane.height - 8);
});

test("resolveAutocompleteAnchorInViewport uses the xterm screen rect in split panes", () => {
  const cellWidth = 5;
  const cellHeight = 200 / 24;
  const screen = {
    clientWidth: 400,
    clientHeight: 200,
    getBoundingClientRect: () => ({
      left: 120,
      top: 260,
      right: 520,
      bottom: 460,
      width: 400,
      height: 200,
      x: 120,
      y: 260,
      toJSON: () => ({}),
    }),
  };
  const container = {
    querySelector: (selector: string) => (selector === ".xterm-screen" ? screen : null),
  } as unknown as HTMLElement;

  const term = {
    element: {
      querySelector: () => null,
    },
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        cursorX: 10,
        cursorY: 20,
        baseY: 0,
        getLine: () => ({ isWrapped: false }),
      },
    },
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: cellWidth, height: cellHeight },
          },
        },
      },
    },
  };

  const anchor = resolveAutocompleteAnchorInViewport(term as never, container, 5, 10);
  assert.equal(anchor.anchorLeft, 120 + cellWidth * 10);
  assert.equal(anchor.anchorTop, 260 + cellHeight * 20);
  assert.equal(anchor.anchorBottom, 260 + cellHeight * 21);
});

test("resolveAutocompleteCursorColumn prefers prompt-aligned column when xterm lags", () => {
  const term = {
    buffer: {
      active: {
        cursorX: 0,
        cursorY: 22,
        baseY: 0,
        getLine: () => ({
          isWrapped: false,
          translateToString: () => "root@host:~# d",
        }),
      },
    },
  };

  const column = resolveAutocompleteCursorColumn(term as never, {
    promptText: "root@host:~# ",
    userInput: "d",
  });
  assert.equal(column, "root@host:~# ".length + 1);
});

test("short popup flips upward when the cursor is at the bottom of the screen", () => {
  // Regression for issue #1710: a *short* suggestion list must flip up when
  // the anchor line is the last visible row, even if there is a tiny positive
  // "phantom" space below the screen rect.
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorTop: 772,
    anchorBottom: 792,
    desiredHeight: 64, // 2 short items
    maxHeight: 240,
  });
  assert.equal(p.renderUpward, true, "short popup should flip upward at bottom row");
  assert.ok(p.top + Math.min(p.maxHeight, 64) <= 772 - baseInput.anchorGap + 0.001,
    "rendered popup should stay above the anchor line");
  assert.ok(p.top >= baseInput.viewportPadding,
    "popup should not be clipped above the viewport");
});

test("clamps a downward popup back inside the terminal when the anchor is above the viewport", () => {
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorTop: -60,
    anchorBottom: -40,
    desiredHeight: 96,
    maxHeight: 240,
    expandUpwardHint: false,
  });
  const contentHeight = Math.min(p.maxHeight, 96);

  assert.equal(p.renderUpward, false);
  assert.ok(
    p.top >= baseInput.viewportPadding,
    `popup top ${p.top} should stay inside the terminal viewport`,
  );
  assert.ok(
    p.top + contentHeight <= baseInput.viewportHeight - baseInput.viewportPadding + 0.001,
    `popup bottom ${p.top + contentHeight} should stay inside the terminal viewport`,
  );
});

test("clamps an upward popup back inside the terminal when the anchor is below the viewport", () => {
  const p = computeAutocompletePopupPlacement({
    ...baseInput,
    anchorTop: 860,
    anchorBottom: 880,
    desiredHeight: 96,
    maxHeight: 240,
    expandUpwardHint: true,
  });
  const contentHeight = Math.min(p.maxHeight, 96);

  assert.equal(p.renderUpward, true);
  assert.ok(
    p.top >= baseInput.viewportPadding,
    `popup top ${p.top} should stay inside the terminal viewport`,
  );
  assert.ok(
    p.top + contentHeight <= baseInput.viewportHeight - baseInput.viewportPadding + 0.001,
    `popup bottom ${p.top + contentHeight} should stay inside the terminal viewport`,
  );
});

test("resolveAutocompleteClampViewport clamps to the xterm screen rect", () => {
  const container = {
    closest: () => null,
    querySelector: (selector: string) =>
      selector === ".xterm-screen"
        ? {
            getBoundingClientRect: () => ({
              left: 100,
              top: 50,
              width: 600,
              height: 400,
              right: 700,
              bottom: 450,
              x: 100,
              y: 50,
              toJSON: () => ({}),
            }),
          }
        : null,
    getBoundingClientRect: () => ({
      left: 100,
      top: 50,
      width: 600,
      height: 410, // 10px taller than the screen
      right: 700,
      bottom: 460,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;

  const clamp = resolveAutocompleteClampViewport(container);
  assert.equal(clamp.top, 50);
  assert.equal(clamp.height, 400, "clamp height should match the screen, not the taller container");
  assert.equal(clamp.width, 600);
});

test("resolveAutocompleteClampViewport prefers the visible terminal screen over the split pane", () => {
  const pane = {
    getAttribute: (name: string) => (name === "data-section" ? "terminal-split-pane" : null),
    getBoundingClientRect: () => ({
      left: 20,
      top: 30,
      width: 500,
      height: 300,
      right: 520,
      bottom: 330,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    }),
  };
  const screen = {
    getBoundingClientRect: () => ({
      left: 25,
      top: 35,
      width: 490,
      height: 280,
      right: 515,
      bottom: 315,
      x: 25,
      y: 35,
      toJSON: () => ({}),
    }),
  };
  const container = {
    closest: (selector: string) =>
      selector === '[data-section="terminal-split-pane"]' ? (pane as never) : null,
    querySelector: (selector: string) =>
      selector === ".xterm-screen" ? (screen as never) : null,
    getBoundingClientRect: () => ({
      left: 20,
      top: 30,
      width: 500,
      height: 310,
      right: 520,
      bottom: 340,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;

  const clamp = resolveAutocompleteClampViewport(container);
  assert.equal(clamp.left, 25, "screen left should win");
  assert.equal(clamp.top, 35, "screen top should win");
  assert.equal(clamp.width, 490, "screen width should win");
  assert.equal(clamp.height, 280, "screen height should win");
});

test("resolveAutocompleteAnchorInViewport ignores the helper textarea horizontal position", () => {
  const cellWidth = 9;
  const cellHeight = 17;
  const screen = {
    clientWidth: 720,
    clientHeight: 408,
    getBoundingClientRect: () => ({
      left: 640,
      top: 180,
      right: 1360,
      bottom: 588,
      width: 720,
      height: 408,
      x: 640,
      y: 180,
      toJSON: () => ({}),
    }),
  };
  const textarea = {
    getBoundingClientRect: () => ({
      left: 640,
      top: 500,
      right: 1360,
      bottom: 517,
      width: 720,
      height: 17,
      x: 640,
      y: 500,
      toJSON: () => ({}),
    }),
  };
  const container = {
    querySelector: (selector: string) => {
      if (selector === ".xterm-screen") return screen;
      if (selector === "textarea.xterm-helper-textarea") return textarea;
      return null;
    },
  } as unknown as HTMLElement;

  const cursorColumn = "root@RainYun-0tWTeTRw:~# ".length + 1;
  const term = {
    element: {
      querySelector: () => null,
    },
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        cursorX: 0,
        cursorY: 22,
        baseY: 0,
        getLine: () => ({ isWrapped: false }),
      },
    },
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: cellWidth, height: cellHeight },
          },
        },
      },
    },
  };

  const anchor = resolveAutocompleteAnchorInViewport(
    term as never,
    container,
    5,
    cursorColumn,
  );
  assert.equal(anchor.anchorLeft, 640 + cellWidth * cursorColumn);
  assert.notEqual(anchor.anchorLeft, textarea.getBoundingClientRect().left);
});
