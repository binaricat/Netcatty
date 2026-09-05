import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import { createNoteCodeTooltipExtensions } from "./noteCodeTooltips";

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
