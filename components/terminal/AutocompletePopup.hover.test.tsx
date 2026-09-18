import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * Regression test for #3426: hovering autocomplete rows must not change the
 * popup's rendered geometry. The detail tooltip used to mount/unmount and
 * resize per hovered row, which fed the wrapper's measured size into the
 * position clamp and moved the popup under a stationary pointer — flipping
 * the hovered row and self-oscillating (violent mousemove jitter).
 */

test("autocomplete popup keeps a fixed geometry while hovering rows (#3426)", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const window = dom.window;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  installGlobal("window", window);
  installGlobal("document", window.document);
  installGlobal("navigator", window.navigator);
  installGlobal("HTMLElement", window.HTMLElement);
  installGlobal("Element", window.Element);
  installGlobal("Node", window.Node);
  installGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  installGlobal("requestAnimationFrame", window.requestAnimationFrame.bind(window));
  installGlobal("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));
  installGlobal("ResizeObserver", ResizeObserverStub);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  try {
    const { default: React, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const AutocompletePopup = (await import("./autocomplete/AutocompletePopup.tsx")).default;
    type CompletionSuggestion = import("./autocomplete/completionEngine.ts").CompletionSuggestion;

    const suggestions: CompletionSuggestion[] = [
      {
        text: "git status",
        displayText: "git status",
        description: "Show the working tree status",
        source: "command",
        score: 10,
      },
      {
        text: "src",
        displayText: "src/",
        source: "path",
        fileType: "directory",
        score: 9,
      },
      {
        text: "git commit",
        displayText: "git commit",
        description: "Record changes to the repository",
        source: "command",
        score: 8,
      },
    ];

    const containerRef = { current: null } as React.RefObject<HTMLDivElement | null>;
    const rootNode = window.document.getElementById("root");
    assert.ok(rootNode);
    const root = createRoot(rootNode);

    await act(async () => {
      root.render(
        <AutocompletePopup
          suggestions={suggestions}
          selectedIndex={-1}
          anchorViewport={{ left: 100, top: 300, bottom: 316 }}
          visible
          themeColors={{ background: "#1e1e2e", foreground: "#cdd6f4", selection: "#444", cursor: "#f5e0dc" }}
          onSelect={() => {}}
          containerRef={containerRef}
        />,
      );
    });

    const findWrapper = (): HTMLElement => {
      const el = Array.from(rootNode.querySelectorAll<HTMLElement>("div"))
        .find((candidate) => candidate.style.zIndex === "10000");
      assert.ok(el, "popup wrapper should be mounted");
      return el;
    };
    const findDetailPanel = (): HTMLElement | null =>
      Array.from(rootNode.querySelectorAll<HTMLElement>("div"))
        .find((el) => el.style.width === "280px") ?? null;

    const wrapper = findWrapper();
    const initialLeft = wrapper.style.left;
    const initialTop = wrapper.style.top;
    assert.ok(initialLeft && initialTop, "popup should be fixed-positioned");

    // Nothing hovered/selected: the detail panel is mounted but hidden so its
    // box is already reserved (matches the placement pass's reservation).
    const hiddenPanel = findDetailPanel();
    assert.ok(hiddenPanel, "detail panel should stay mounted for the whole set");
    assert.equal(hiddenPanel.style.visibility, "hidden");
    const fixedHeight = hiddenPanel.style.height;
    assert.ok(fixedHeight && fixedHeight !== "0px", "detail panel should reserve a fixed height");

    const hoverRow = async (rowIndex: number) => {
      const label = Array.from(rootNode.querySelectorAll<HTMLElement>("span"))
        .find((el) => el.textContent === suggestions[rowIndex].displayText);
      assert.ok(label, `row for ${suggestions[rowIndex].displayText} should be rendered`);
      const row = label.closest<HTMLElement>("div[style*='cursor']");
      assert.ok(row, "row container should be a hoverable div");
      await act(async () => {
        row.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      });
    };

    // Hover the describable row: detail becomes visible, geometry unchanged.
    await hoverRow(0);
    assert.equal(wrapper.style.left, initialLeft, "hover must not shift popup left");
    assert.equal(wrapper.style.top, initialTop, "hover must not change popup top");
    const shownPanel = findDetailPanel();
    assert.ok(shownPanel);
    assert.equal(shownPanel.style.visibility, "visible");
    assert.equal(shownPanel.style.height, fixedHeight, "detail box must be hover-independent");
    assert.ok(shownPanel.textContent?.includes("Show the working tree status"));

    // Hover the path row (no detail): panel hides via visibility, stays
    // mounted with the same fixed box, and the popup does not move.
    await hoverRow(1);
    assert.equal(wrapper.style.left, initialLeft, "hovering a path row must not move the popup");
    assert.equal(wrapper.style.top, initialTop, "hovering a path row must not shift the popup");
    const panelAfterPathHover = findDetailPanel();
    assert.ok(panelAfterPathHover, "detail panel must remain mounted while hovering path rows");
    assert.equal(panelAfterPathHover.style.visibility, "hidden");
    assert.equal(panelAfterPathHover.style.height, fixedHeight);
    assert.equal(panelAfterPathHover.style.width, "280px");

    // Hovering another describable row is equally geometry-stable.
    await hoverRow(2);
    assert.equal(wrapper.style.left, initialLeft);
    assert.equal(wrapper.style.top, initialTop);

    // A hidden detail reserve must not intercept clicks through the wrapper.
    assert.equal(wrapper.style.pointerEvents, "none");
    await hoverRow(1);
    assert.equal(findDetailPanel()?.style.pointerEvents, "none");
    await hoverRow(0);
    assert.equal(findDetailPanel()?.style.pointerEvents, "auto");

    // Exercise pane sizes down to the supported split minimum. JSDOM cannot
    // perform flex layout, so check the constraints that let Chromium shrink
    // both panels without tying their size to the hovered description.
    for (const width of [400, 240, 120]) {
      const container = window.document.createElement("div");
      container.getBoundingClientRect = () => ({
        left: 0, top: 0, right: width, bottom: 600,
        width, height: 600, x: 0, y: 0, toJSON: () => ({}),
      });
      await act(async () => {
        root.render(
          <AutocompletePopup
            suggestions={suggestions}
            selectedIndex={-1}
            anchorViewport={{ left: width - 30, top: 500, bottom: 516 }}
            visible
            onSelect={() => {}}
            containerRef={{ current: container }}
          />,
        );
      });
      assert.equal(findWrapper().style.maxWidth, `${width - 16}px`);
      const list = rootNode.querySelector<HTMLElement>(".xterm-autocomplete-popup");
      assert.ok(list);
      assert.ok(parseFloat(list.style.minWidth) <= (width - 16) / 2);
      for (const index of [0, 1, 2]) {
        await hoverRow(index);
        const detail = findDetailPanel();
        assert.ok(detail);
        assert.equal(detail.style.minWidth, "0px");
        assert.equal(detail.style.flexShrink, "1");
      }
    }

    await act(async () => {
      root.unmount();
    });
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
