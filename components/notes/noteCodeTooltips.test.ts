import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import { syncNoteCodeTooltipStyle, createNoteCodeTooltipExtensions, getNoteTooltipSpace } from "./noteCodeTooltips";

const stubRect = (element: Element, top: number, left: number, right: number, bottom: number) => {
  element.getBoundingClientRect = () => ({
    top,
    left,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
};

test("note tooltips escape clipped code blocks and disappear with their editor", () => {
  const dom = new JSDOM('<div id="note" style="overflow:hidden;height:20px"></div>', {
    pretendToBeVisual: true,
  });
  const keys = ["window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of keys) {
    const value = dom.window[key];
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: typeof value === "function" && key.includes("AnimationFrame") ? value.bind(dom.window) : value,
    });
  }
  let view: EditorView | undefined;
  try {
    const parent = dom.window.document.querySelector("#note") as HTMLElement;
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "con",
        extensions: [
          ...createNoteCodeTooltipExtensions(dom.window.document.body),
          showTooltip.of({
            pos: 0,
            create() {
              const tooltip = dom.window.document.createElement("div");
              tooltip.textContent = "const";
              return { dom: tooltip };
            },
          }),
        ],
      }),
    });
    const tooltip = dom.window.document.querySelector(".cm-tooltip")!;
    assert.ok(tooltip);
    assert.equal(parent.contains(tooltip), false);
    assert.equal(tooltip.parentElement?.parentElement, dom.window.document.body);
    for (const themeClass of view.themeClasses.split(" ")) {
      assert.ok(tooltip.parentElement?.classList.contains(themeClass));
    }
    view.dom.style.setProperty("--popover", "120 50% 20%");
    view.dom.style.setProperty("--accent", "120 70% 40%");
    syncNoteCodeTooltipStyle(view, { top: 0, left: 100, right: 300, bottom: 400 });
    assert.equal((tooltip as HTMLElement).style.getPropertyValue("--popover"), "120 50% 20%");
    assert.equal((tooltip as HTMLElement).style.getPropertyValue("--accent"), "120 70% 40%");
    assert.equal((tooltip as HTMLElement).style.getPropertyValue("--note-tooltip-width"), "200px");
    view.dom.style.setProperty("--popover", "240 50% 20%");
    view.dom.style.removeProperty("--accent");
    syncNoteCodeTooltipStyle(view, { top: 0, left: 100, right: 250, bottom: 400 });
    assert.equal((tooltip as HTMLElement).style.getPropertyValue("--popover"), "240 50% 20%");
    assert.equal((tooltip as HTMLElement).style.getPropertyValue("--accent"), "");
    assert.equal((tooltip as HTMLElement).style.getPropertyValue("--note-tooltip-width"), "150px");
    view.destroy();
    view = undefined;
    assert.equal(dom.window.document.querySelector(".cm-tooltip"), null);
  } finally {
    view?.destroy();
    keys.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});

test("note tooltip space is bounded by clipping pane ancestors", () => {
  const dom = new JSDOM('<div id="pane" style="overflow:hidden"><div id="note"></div></div>');
  const pane = dom.window.document.querySelector("#pane") as HTMLElement;
  const note = dom.window.document.querySelector("#note") as HTMLElement;
  stubRect(pane, 100, 200, 600, 500);
  // The notes editor extends below its pane; a tooltip must not follow it out.
  stubRect(note, 150, 250, 550, 700);
  const realGetComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = ((element: Element) => ({
    ...realGetComputedStyle(element),
    overflowX: element === pane ? "hidden" : "visible",
    overflowY: element === pane ? "hidden" : "visible",
  })) as typeof dom.window.getComputedStyle;
  try {
    assert.deepEqual(getNoteTooltipSpace(note, dom.window.document), {
      top: 150,
      left: 250,
      right: 550,
      bottom: 500,
    });
  } finally {
    dom.window.close();
  }
});

test("note tooltip space honors paint containment without overflow clipping", () => {
  const dom = new JSDOM(
    '<style>#pane{contain:strict}</style><div id="pane"><div id="note"></div></div>',
  );
  const pane = dom.window.document.querySelector("#pane") as HTMLElement;
  const note = dom.window.document.querySelector("#note") as HTMLElement;
  stubRect(pane, 0, 0, 800, 600);
  stubRect(note, 50, -50, 850, 900);
  const realGetComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = ((element: Element) => ({
    ...realGetComputedStyle(element),
    overflowX: "visible",
    overflowY: "visible",
    contain: element === pane ? "strict" : "none",
  })) as typeof dom.window.getComputedStyle;
  try {
    assert.deepEqual(getNoteTooltipSpace(note, dom.window.document), {
      top: 50,
      left: 0,
      right: 800,
      bottom: 600,
    });
  } finally {
    dom.window.close();
  }
});

test("note tooltip space falls back to window bounds when the editor is unmounted", () => {
  const dom = new JSDOM("<div></div>");
  const detached = dom.window.document.createElement("div");
  try {
    assert.deepEqual(getNoteTooltipSpace(detached, dom.window.document), {
      top: 0,
      left: 0,
      right: dom.window.document.documentElement.clientWidth,
      bottom: dom.window.document.documentElement.clientHeight,
    });
  } finally {
    dom.window.close();
  }
});
