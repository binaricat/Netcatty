import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("NoteToolbar fits formatting controls to the available row width", async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const { window } = dom;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let rowWidth = 900;
  const observers = new Set<ResizeObserverStub>();
  class ResizeObserverStub {
    target: Element | null = null;
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.target = target; }
    unobserve() { this.target = null; }
    disconnect() { observers.delete(this); }
  }
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-note-format-toolbar")) {
      return new window.DOMRect(0, 0, rowWidth, 26);
    }
    return originalRect.call(this);
  };
  for (const key of [
    "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement",
    "Element", "SVGElement", "Node", "NodeFilter", "MutationObserver", "CustomEvent",
    "Event", "MouseEvent", "DOMRect",
  ]) {
    installGlobal(key, window[key as keyof typeof window]);
  }
  installGlobal("window", window);
  installGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  installGlobal("requestAnimationFrame", window.requestAnimationFrame.bind(window));
  installGlobal("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));
  installGlobal("ResizeObserver", ResizeObserverStub);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { default: React, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("../ui/tooltip.tsx");
  const { NoteToolbar } = await import("./NoteToolbar.tsx");
  const { EMPTY_ACTIVE_FORMATS } = await import("./noteEditorTypes.ts");
  const root = createRoot(window.document.getElementById("root")!);
  const actions: string[] = [];
  const sizes: number[] = [];
  const codeSizes: number[] = [];
  const fonts: string[] = [];
  const render = async (mode: "edit" | "source" | "preview" = "edit") => {
    await act(async () => root.render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <NoteToolbar
            editorMode={mode}
            onAction={(action) => actions.push(action)}
            onChangeNoteFontFamily={(font) => fonts.push(font)}
            onChangeNoteFontSize={(size) => sizes.push(size)}
            onChangeNoteCodeFontSize={(size) => codeSizes.push(size)}
            activeFormats={{ ...EMPTY_ACTIVE_FORMATS, bold: true }}
          />
        </TooltipProvider>
      </I18nProvider>,
    ));
  };
  const row = (): HTMLElement => {
    const element = window.document.querySelector<HTMLElement>("[data-note-format-toolbar]");
    assert.ok(element);
    assert.ok(element.classList.contains("overflow-hidden"));
    assert.doesNotMatch(element.className, /overflow-x-auto|overflow-auto|scrollbar/);
    assert.ok(!element.classList.contains("flex-wrap"));
    return element;
  };
  const buttonLabel = (element: HTMLButtonElement) =>
    element.getAttribute("aria-label") || element.textContent?.trim() || "";
  const button = (label: string, parent: ParentNode = window.document) => {
    const element = Array.from(parent.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => buttonLabel(candidate) === label);
    assert.ok(element, `${label} should be reachable`);
    return element;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await new Promise((resolve) => window.setTimeout(resolve, 70));
    });
  };
  const resize = async (width: number) => {
    rowWidth = width;
    await act(async () => {
      for (const observer of observers) {
        if (observer.target?.hasAttribute("data-note-format-toolbar")) {
          observer.callback([{
            target: observer.target,
            contentRect: new window.DOMRect(0, 0, width, 26),
          } as ResizeObserverEntry], observer as unknown as ResizeObserver);
        }
      }
    });
  };
  const openOverflow = async (): Promise<HTMLElement> => {
    const trigger = row().querySelector<HTMLButtonElement>("[data-toolbar-overflow-trigger]");
    assert.ok(trigger);
    await click(trigger);
    const menu = window.document.querySelector<HTMLElement>("[data-toolbar-overflow-menu]");
    assert.ok(menu);
    return menu;
  };

  try {
    await render();
    const defaultOrder = Array.from(row().querySelectorAll<HTMLButtonElement>("button"), buttonLabel);

    await t.test("wide row preserves all controls inline without a scrollbar track", async () => {
      assert.equal(defaultOrder.length, 19);
      assert.equal(row().querySelectorAll("button[title]").length, 0, "toolbar buttons should use custom tooltips instead of native title");
      assert.deepEqual(defaultOrder.slice(0, 5), ["Undo (Ctrl+Z)", "Redo (Ctrl+Y)", "Code font and typography settings", "Heading Level", "Bold (Ctrl+B)"]);
      assert.equal(defaultOrder.at(-1), "Insert Image");
      assert.equal(row().querySelector("[data-toolbar-overflow-trigger]"), null);
      assert.ok(button("Bold (Ctrl+B)", row()).classList.contains("bg-primary/15"));
      const mouseDown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      button("Bold (Ctrl+B)", row()).dispatchEvent(mouseDown);
      assert.equal(mouseDown.defaultPrevented, true, "formatting preserves the editor selection");
      await click(button("Bold (Ctrl+B)", row()));
      assert.equal(actions.at(-1), "bold");
    });

    await t.test("narrow row spills the end of the existing order and keeps every action reachable", async () => {
      await resize(320);
      const inlineLabels = Array.from(
        row().querySelectorAll<HTMLButtonElement>("button:not([data-toolbar-overflow-trigger])"),
        buttonLabel,
      );
      assert.ok(inlineLabels.length < defaultOrder.length);
      assert.deepEqual(inlineLabels, defaultOrder.slice(0, inlineLabels.length));
      const menu = await openOverflow();
      const overflowLabels = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"), buttonLabel);
      assert.equal(menu.querySelectorAll("button[title]").length, 0);
      assert.deepEqual([...inlineLabels, ...overflowLabels], defaultOrder);
      const expectedActions = ["bullet", "number", "task", "quote", "codeblock", "math", "table", "divider", "link", "image"];
      for (let index = 0; index < overflowLabels.length; index += 1) {
        const currentMenu = index === 0 ? menu : await openOverflow();
        await click(button(overflowLabels[index], currentMenu));
        assert.equal(actions.at(-1), expectedActions[index]);
        assert.equal(window.document.querySelector("[data-toolbar-overflow-menu]"), null);
      }
    });

    await t.test("very narrow row exposes undo, headings, and typography through nested overflow menus", async () => {
      await resize(26);
      assert.equal(row().querySelectorAll("button").length, 1);
      await click(button("Undo (Ctrl+Z)", await openOverflow()));
      assert.equal(actions.at(-1), "undo");
      await click(button("Redo (Ctrl+Y)", await openOverflow()));
      assert.equal(actions.at(-1), "redo");

      await click(button("Heading Level", await openOverflow()));
      assert.ok(window.document.querySelector("[data-toolbar-overflow-menu]"));
      let nested = window.document.querySelector<HTMLElement>("[data-toolbar-nested-menu]");
      assert.ok(nested);
      await click(nested.querySelector<HTMLButtonElement>("button")!);
      assert.equal(actions.at(-1), "h1");
      assert.equal(window.document.querySelector("[data-toolbar-overflow-menu]"), null);

      for (const setting of ["font", "body", "code"] as const) {
        await click(button("Code font and typography settings", await openOverflow()));
        nested = window.document.querySelector<HTMLElement>("[data-toolbar-nested-menu]");
        assert.ok(nested);
        assert.ok(window.document.querySelector("[data-toolbar-overflow-menu]"));
        const sections = nested.children;
        const section = sections[setting === "font" ? 0 : setting === "body" ? 1 : 2];
        await click(section.querySelector<HTMLButtonElement>("button")!);
        assert.equal(window.document.querySelector("[data-toolbar-overflow-menu]"), null);
      }
      assert.deepEqual(fonts, [""]);
      assert.deepEqual(sizes, [12]);
      assert.deepEqual(codeSizes, [11]);
    });

    await t.test("resizing back to wide restores controls and removes the overflow trigger", async () => {
      await resize(900);
      assert.deepEqual(Array.from(row().querySelectorAll<HTMLButtonElement>("button"), buttonLabel), defaultOrder);
      assert.equal(row().querySelector("[data-toolbar-overflow-trigger]"), null);
    });

    await t.test("source mode and returning from preview remeasure the same format row", async () => {
      await render("preview");
      assert.equal(window.document.querySelector("[data-note-format-toolbar]"), null);
      rowWidth = 200;
      await render("source");
      const menu = await openOverflow();
      assert.ok(button("Bold (Ctrl+B)", row()).classList.contains("bg-primary/15"));
      await click(button("Insert Image", menu));
      assert.equal(actions.at(-1), "image");
    });
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    assert.equal(observers.size, 0);
    dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("full notes and the sidebar overlay both render the shared format toolbar", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("../ui/tooltip.tsx");
  const { NotesManager } = await import("./NotesManager.tsx");
  for (const displayMode of ["full", "sidebar"] as const) {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en">
        <TooltipProvider>
          <NotesManager
            notes={[{ id: "note-1", title: "Test note", content: "# Note", group: "", createdAt: 1, updatedAt: 1, order: 1 }]}
            noteGroups={[]}
            hosts={[]}
            onUpdateNotes={() => undefined}
            onUpdateNoteGroups={() => undefined}
            displayMode={displayMode}
            openNoteId="note-1"
          />
        </TooltipProvider>
      </I18nProvider>,
    );
    const dom = new JSDOM(markup);
    try {
      const rows = dom.window.document.querySelectorAll("[data-note-format-toolbar]");
      assert.equal(rows.length, 1, `${displayMode} should use NoteToolbar`);
      assert.doesNotMatch(rows[0].className, /overflow-x-auto|overflow-auto|scrollbar/);
      assert.equal(rows[0].querySelectorAll("button").length, 19);
      assert.equal(rows[0].querySelectorAll("button[title]").length, 0);
      assert.equal(dom.window.document.querySelector("[data-note-title-row] button[aria-label='Undo (Ctrl+Z)']"), null);
      assert.equal(dom.window.document.querySelector("[data-note-title-row] button[title]"), null);
    } finally {
      dom.window.close();
    }
  }
});
