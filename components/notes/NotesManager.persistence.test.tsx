import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React, { act } from "react";
import type { VaultNote } from "../../domain/models.ts";

// JSDOM has no stylesheet loader. All editor/application JavaScript stays real.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith("/components/notes/noteMath.scss")) {
      return { format: "module", source: "export {};", shortCircuit: true };
    }
    return nextLoad(url, context);
  }
`)}`, import.meta.url);

// Same browser shims as InlineMarkdownEditor.unrenderableMarkdown.test.tsx.
import {JSDOM} from "jsdom";
const setupDom = () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const window = dom.window;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  function LoadedImageStub() {
    const image = window.document.createElement("img");
    Object.defineProperty(image, "src", {
      get: () => image.getAttribute("src") ?? "",
      set: (src: string) => {
        image.setAttribute("src", src);
        queueMicrotask(() => image.dispatchEvent(new window.Event("load")));
      },
    });
    return image;
  }

  Object.assign(window.Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => new window.DOMRect(),
  });

  // CodeMirror needs these browser APIs when the full note contains code blocks.
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });

  for (const [key, value] of Object.entries({
    window,
    Window: window.Window,
    Image: LoadedImageStub,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    SVGElement: window.SVGElement,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    Range: window.Range,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent,
    DOMRect: window.DOMRect,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: ResizeObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    installGlobal(key, value);
  }

  return {
    window,
    cleanup() {
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      dom.window.close();
    },
  };
};

for (const mode of ["source", "edit"] as const) {
  test(`mounted notes ${mode}: failed save retains both versions through retry and switching`, { timeout: 30_000 }, async (t) => {
    const { window, cleanup } = setupDom();
    // The app initializes unrelated vault collections under Web Locks. Serialize
    // those calls in the fixture too (Node 22 does not always expose Web Locks).
    const tails = new Map<string, Promise<unknown>>();
    Object.defineProperty(window.navigator, "locks", { value: {
      request(name: string, callback: () => unknown) {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback, callback);
        tails.set(name, run.then(() => undefined, () => undefined));
        return run;
      },
    } });
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
    const keys = await import("../../infrastructure/config/storageKeys.ts");
    for (const [name, key] of Object.entries(keys)) {
      if (name.startsWith("STORAGE_KEY_") && typeof key === "string") window.localStorage.setItem(key, "[]");
    }
    const original: VaultNote = { id: "synthetic-note", title: "Synthetic note", content: "Persisted baseline", createdAt: 1, updatedAt: 1, order: 0 };
    const second: VaultNote = { ...original, id: "second-note", title: "Second note", content: "Second body", order: 1 };
    window.localStorage.setItem(keys.STORAGE_KEY_NOTES, JSON.stringify([original, second]));
    window.localStorage.setItem(keys.STORAGE_KEY_VAULT_NOTES_EDITOR_MODE, mode);
    const { useVaultState } = await import("../../application/state/useVaultState.ts");
    const { getNotesSnapshot, subscribeNotes } = await import("../../application/state/notesStore.ts");
    const { setNotify } = await import("../../application/notification.ts");
    const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
    const { TooltipProvider } = await import("../ui/tooltip.tsx");
    const { NotesManager } = await import("./NotesManager.tsx");
    const { createRoot } = await import("react-dom/client");
    const rootNode = window.document.getElementById("root")!;
    const root = createRoot(rootNode);
    let vault!: ReturnType<typeof useVaultState>;
    let openNote!: React.Dispatch<React.SetStateAction<string>>;
    const saveResults: boolean[] = [];
    const notices: string[] = [];
    let quota = false;
    const realSetItem = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key: string, value: string) {
      if (quota && key === keys.STORAGE_KEY_NOTES) throw new DOMException("Synthetic quota exceeded", "QuotaExceededError");
      return realSetItem.call(this, key, value);
    };
    setNotify({ error: message => notices.push(message), info: () => {}, warning: () => {}, success: () => {} });
    function App() {
      const state = useVaultState();
      vault = state;
      const [noteId, setNoteId] = React.useState(original.id);
      openNote = setNoteId;
      const updateNotes = state.updateNotes;
      const save = React.useCallback((notes: VaultNote[]) => {
        const result = updateNotes(notes);
        saveResults.push(result);
        return result;
      }, [updateNotes]);
      return <I18nProvider locale="en"><TooltipProvider><NotesManager notes={state.notes} noteGroups={state.noteGroups}
        hosts={[]} onUpdateNotes={save} onUpdateNoteGroups={state.updateNoteGroups} displayMode="full" openNoteId={noteId} />
      </TooltipProvider></I18nProvider>;
    }
    const editor = () => mode === "source" ? rootNode.querySelector<HTMLTextAreaElement>("textarea") : rootNode.querySelector<HTMLElement>('[contenteditable="true"]');
    const visible = () => (mode === "source" ? (editor() as HTMLTextAreaElement)?.value : editor()?.textContent)?.trim();
    const waitFor = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 6000;
      while (!check()) {
        assert.ok(Date.now() < deadline, `${label}; saves=${JSON.stringify(saveResults)}, visible=${visible()}, notes=${JSON.stringify(vault.notes)}`);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      }
    };
    const persisted = (): VaultNote[] => JSON.parse(window.localStorage.getItem(keys.STORAGE_KEY_NOTES)!);
    const primary = () => vault.notes.find(note => note.id === original.id)!;
    const edit = async (content: string) => {
      await act(async () => {
        if (mode === "source") {
          const textarea = editor() as HTMLTextAreaElement;
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, content);
          textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
        } else {
          const lexical = await import("lexical");
          const instance = lexical.getNearestEditorFromDOMNode(editor()!);
          assert.ok(instance);
          instance.update(() => { lexical.$getRoot().clear().append(lexical.$createParagraphNode().append(lexical.$createTextNode(content))); }, { discrete: true });
        }
      });
      await waitFor(() => visible() === content, "local edit is visible");
    };
    const incoming = async (notes: VaultNote[]) => {
      const value = JSON.stringify(notes);
      // Independent writer bypasses only our synthetic quota failure.
      realSetItem.call(window.localStorage, keys.STORAGE_KEY_NOTES, value);
      await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", { key: keys.STORAGE_KEY_NOTES, newValue: value, storageArea: window.localStorage })); });
    };
    try {
      await act(async () => root.render(<App />));
      await waitFor(() => vault.isInitialized && visible() === original.content, "initial editor");
      await edit("Successfully saved");
      await waitFor(() => saveResults.length === 1, "normal successful debounce");
      assert.equal(saveResults[0], true);
      assert.equal(persisted()[0].content.trim(), "Successfully saved");
      await incoming([{ ...original, content: "Legitimate external update", updatedAt: 5 }, second]);
      await waitFor(() => visible() === "Legitimate external update", "external update after successful save");

      quota = true;
      const local = "Unsaved local draft";
      await edit(local);
      assert.equal(saveResults.length, 1, "dirty control precedes autosave echo");
      await incoming([{ ...original, content: "Remote before echo", updatedAt: 10 }, second]);
      assert.equal(primary().content, "Remote before echo");
      assert.equal(visible(), local, "existing editor dirty guard works before echo");
      await waitFor(() => saveResults.length === 2 && primary().content.trim() === local, "failed save optimistic echo");
      assert.equal(saveResults[1], false);
      assert.equal(notices.length, 1);
      assert.equal(persisted()[0].content, "Remote before echo");
      assert.ok(primary().updatedAt > 11, "incoming timestamps deliberately run behind local time");
      const remote = [{ ...original, content: "Remote after echo", updatedAt: 11 }, second];
      await incoming(remote);
      assert.equal(visible(), local, "failed optimistic echo must not acknowledge durability");
      assert.equal(primary().content.trim(), local);
      assert.equal(getNotesSnapshot().notes.find(note => note.id === original.id)!.content.trim(), local);
      const copy = vault.notes.find(note => note.id !== original.id && note.content === "Remote after echo");
      assert.ok(copy, "external conflicting content must remain accessible as a note");
      const copyId = copy.id;

      await incoming(remote);
      assert.equal(vault.notes.length, 3, "repeated storage delivery creates no duplicate copy");
      await edit("Unsaved local draft revision two");
      await waitFor(() => saveResults.length === 3, "second failed debounce");
      assert.equal(saveResults[2], false);
      assert.equal(notices.length, 1, "repeated failure respects notification throttling");
      await act(async () => openNote(second.id));
      await waitFor(() => visible() === second.content, "switch to second note");
      await act(async () => openNote(original.id));
      await waitFor(() => visible() === "Unsaved local draft revision two", "switch back retains failed draft");
      // Switching notes intentionally defers the content swap by two frames.
      await act(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });
      assert.equal(vault.notes.find(note => note.id === copyId)?.content, "Remote after echo");

      quota = false;
      await edit("Durable recovered draft");
      await waitFor(() => saveResults.length === 4, "successful retry");
      assert.equal(saveResults[3], true);
      assert.equal(persisted().find(note => note.id === original.id)?.content.trim(), "Durable recovered draft");
      assert.equal(persisted().find(note => note.id === copyId)?.content, "Remote after echo");
      const afterSuccess = persisted().map(note => note.id === original.id ? { ...note, content: "External after recovery", updatedAt: 2 } : note);
      await incoming(afterSuccess);
      await waitFor(() => visible() === "External after recovery", "successful same-generation save releases pending protection");
      assert.equal(vault.notes.length, 3);

      await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", {
        key: keys.STORAGE_KEY_NOTES, newValue: JSON.stringify(remote), storageArea: window.localStorage,
      })); });
      assert.equal(visible(), "External after recovery", "queued obsolete storage events must not roll back a successful save");

      // Publishing a successful generation can synchronously trigger another
      // write. The older acknowledgement must never clear the newer failure.
      let nestedResult: boolean | undefined;
      let triggered = false;
      const unsubscribe = subscribeNotes(() => {
        if (triggered) return;
        triggered = true;
        quota = true;
        nestedResult = vault.updateNotes(getNotesSnapshot().notes.map(note => note.id === original.id ? { ...note, content: "Newer failed generation" } : note));
      });
      try {
        await act(async () => {
          assert.equal(vault.updateNotes(vault.notes.map(note => note.id === original.id ? { ...note, content: "Older successful generation" } : note)), true);
        });
      } finally { unsubscribe(); }
      assert.equal(nestedResult, false);
      await incoming(persisted().map(note => note.id === original.id ? { ...note, content: "Concurrent with newer failure" } : note));
      assert.equal(primary().content, "Newer failed generation");
      assert.ok(vault.notes.some(note => note.content === "Concurrent with newer failure"));

      // Full-snapshot replacement (clear/restore) remains explicit and does not
      // accidentally resurrect a disk-only note through the save-time rebase.
      quota = false;
      realSetItem.call(window.localStorage, keys.STORAGE_KEY_NOTES, JSON.stringify([...persisted(), { ...second, id: "disk-only" }]));
      await act(async () => { assert.equal(vault.updateNotes([original], { replace: true }), true); });
      assert.deepEqual(persisted().map(note => note.id), [original.id]);

      for (const operation of ["clear", "import"] as const) {
        await t.test(`failed ${operation} retains replacement ownership through events and retry`, async () => {
          quota = false;
          await act(async () => { assert.equal(vault.updateNotes([original, second], { replace: true }), true); });
          const replacement = operation === "clear" ? [] : [{ ...original, content: "Imported snapshot" }];
          quota = true;
          await act(async () => {
            if (operation === "clear") vault.clearVaultData();
            else await vault.importDataFromString(JSON.stringify({ notes: replacement }));
          });
          const contents = (notes: VaultNote[]) => notes.map(({ id, content }) => [id, content]);
          assert.deepEqual(contents(vault.notes), contents(replacement));
          assert.deepEqual(contents(persisted()), contents([original, second]), "replacement has not reached disk");
          const peer = [
            { ...original, content: "Changed in another window", updatedAt: 30 }, second,
            { ...second, id: "peer-added", content: "Added in another window" },
          ];
          await incoming(peer);
          assert.deepEqual(contents(vault.notes), contents(replacement), "failed replacement must not adopt peer edits or additions");
          assert.deepEqual(contents(getNotesSnapshot().notes), contents(replacement));

          const edited = operation === "clear"
            ? [{ ...original, id: "created-after-clear", content: "New local note" }]
            : replacement.map(note => ({ ...note, content: "Edited after import" }));
          await act(async () => { assert.equal(vault.updateNotes(edited), false); });
          await incoming([...peer, { ...second, id: "peer-added-again" }]);
          assert.deepEqual(contents(vault.notes), contents(edited), "an ordinary failed edit must inherit replacement ownership");

          // Also cover a peer write whose storage event has not arrived yet.
          realSetItem.call(window.localStorage, keys.STORAGE_KEY_NOTES, JSON.stringify([...peer, { ...second, id: "unobserved-peer" }]));
          quota = false;
          await act(async () => { assert.equal(vault.updateNotes(vault.notes), true); });
          assert.deepEqual(contents(persisted()), contents(edited), "successful retry persists only the replacement catalog");
          const afterReplacement = [{ ...second, id: "legitimate-later-peer" }];
          await incoming(afterReplacement);
          assert.deepEqual(contents(vault.notes), contents(afterReplacement), "successful current owner releases replacement protection");
        });
      }
      console.log(`NOTES_FIX_${mode.toUpperCase()}: success, dirty-before-echo, failed-echo conflict, duplicate delivery, repeated failure, switch, retry, legal external update passed`);
    } finally {
      await act(async () => root.unmount());
      window.Storage.prototype.setItem = realSetItem;
      setNotify({ error: () => {}, info: () => {}, warning: () => {}, success: () => {} });
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete (globalThis as Record<string, unknown>).localStorage;
      cleanup();
    }
  });
}
