import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./snippets/SnippetScriptEditor"
      && context.parentURL?.endsWith("/SnippetsRightPanel.tsx")
    ) {
      return {
        url: "data:text/javascript,export function SnippetScriptEditor(){return null}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

import { I18nProvider, useI18n } from "../application/i18n/I18nProvider.tsx";
import type { Snippet } from "../types.ts";
import { Dialog } from "./ui/dialog.tsx";

const {
  default: SnippetsManager,
  SNIPPET_IMPORT_SAMPLE_FILES,
  SnippetImportDialogContent,
  buildSnippetImportSamplesZip,
} = await import("./SnippetsManager.tsx");

const installStorageStub = () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
};

const snippet: Snippet = {
  id: "snippet-1",
  label: "Restart nginx",
  command: "sudo systemctl restart nginx",
  tags: [],
  package: "ops",
  targets: ["host-1"],
};

test("SnippetsManager renders import and multi-select controls", () => {
  installStorageStub();
  const noop = () => {};

  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SnippetsManager
        snippets={[snippet]}
        packages={["ops"]}
        hosts={[]}
        hotkeyScheme="mac"
        keyBindings={[]}
        onSave={noop}
        onBulkSave={noop}
        onDelete={noop}
        onPackagesChange={noop}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Import/);
  assert.match(markup, /Select snippets/);
  assert.doesNotMatch(markup, /Snippet import format/);
});

test("SnippetImportDialog shows example JSON before import confirmation", () => {
  const noop = () => {};

  const TestDialog = () => {
    const { t } = useI18n();
    const fileInputRef = React.createRef<HTMLInputElement>();
    return (
      <Dialog open={true}>
        <SnippetImportDialogContent
          pendingImport={null}
          t={t}
          fileInputRef={fileInputRef}
          onFileSelected={noop}
          onChooseFile={noop}
          onConfirmSkip={noop}
          onConfirmOverwrite={noop}
          onCancel={noop}
          onDownloadExamples={noop}
        />
      </Dialog>
    );
  };

  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <TestDialog />
    </I18nProvider>,
  );

  assert.match(markup, /Example JSON/);
  assert.match(markup, /netcatty\.snippets/);
  assert.match(markup, /JSON array/);
  assert.match(markup, /Choose file/);
  assert.match(markup, /Download samples/);
  assert.match(markup, /Confirm import/);
  assert.match(markup, /multiple=""/);
});

test("snippet import sample files include standard and array formats", () => {
  assert.equal(SNIPPET_IMPORT_SAMPLE_FILES.length, 5);
  assert.ok(SNIPPET_IMPORT_SAMPLE_FILES.some((file) => file.name === "01-standard-netcatty-object.json"));
  assert.ok(SNIPPET_IMPORT_SAMPLE_FILES.some((file) => file.name === "02-plain-snippet-array.json"));
  assert.deepEqual(JSON.parse(SNIPPET_IMPORT_SAMPLE_FILES[1].content).map((item: { command: string }) => item.command), [
    "ss -lntp",
    "pwd",
  ]);
});

test("buildSnippetImportSamplesZip returns a zip archive with all sample entries", async () => {
  const blob = buildSnippetImportSamplesZip();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder().decode(bytes);

  assert.equal(blob.type, "application/zip");
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  // General purpose bit flag sets UTF-8 encoding (0x0800) via shared lib/textZip builder.
  assert.equal(view.getUint16(6, true), 0x0800);
  // End of central directory signature at tail (fixed 22-byte EOCD with 0-length comment).
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), SNIPPET_IMPORT_SAMPLE_FILES.length);
  for (const file of SNIPPET_IMPORT_SAMPLE_FILES) {
    assert.ok(text.includes(file.name), `missing ${file.name} in zip archive`);
    assert.ok(text.includes(`${file.content}\n`), `missing trailing newline for ${file.name}`);
  }
});

test("SnippetsManager blocks shortkey recording while app lock overlay is active", async () => {
  installStorageStub();
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;
  const prevKeyboardEvent = globalThis.KeyboardEvent;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevNode = globalThis.Node;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = env.IS_REACT_ACT_ENVIRONMENT;

  env.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "KeyboardEvent", { value: dom.window.KeyboardEvent, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: (id: number) => clearTimeout(id),
    configurable: true,
  });

  const noop = () => {};
  let root: Root | undefined;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(
        <I18nProvider locale="en">
          <SnippetsManager
            snippets={[snippet]}
            packages={["ops"]}
            hosts={[]}
            hotkeyScheme="pc"
            keyBindings={[]}
            openSnippetId={snippet.id}
            openSnippetRequestId={1}
            onSave={noop}
            onBulkSave={noop}
            onDelete={noop}
            onPackagesChange={noop}
          />
        </I18nProvider>,
      );
    });

    const recordButton = (Array.from(dom.window.document.querySelectorAll("button")) as HTMLButtonElement[]).find((button) => (
      (button.textContent ?? "").includes("Click to set shortcut")
    ));
    assert.ok(recordButton, "expected shortkey record button in SnippetsManager edit panel");

    await act(async () => {
      recordButton.click();
    });
    assert.match(recordButton.textContent ?? "", /Press a key combination/);

    const lockOverlay = dom.window.document.createElement("div");
    lockOverlay.setAttribute("data-app-lock-overlay", "true");
    dom.window.document.body.appendChild(lockOverlay);

    const lockedEvent = new dom.window.KeyboardEvent("keydown", {
      key: "j",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(lockedEvent);
    });
    assert.equal(lockedEvent.defaultPrevented, false);
    assert.match(recordButton.textContent ?? "", /Press a key combination/);

    lockOverlay.remove();

    const unlockedEvent = new dom.window.KeyboardEvent("keydown", {
      key: "j",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(unlockedEvent);
    });
    assert.equal(unlockedEvent.defaultPrevented, true);
    assert.match(recordButton.textContent ?? "", /Ctrl \+ Shift \+ J/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    env.IS_REACT_ACT_ENVIRONMENT = prevAct;
    Object.defineProperty(globalThis, "window", { value: prevWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: prevDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
    Object.defineProperty(globalThis, "KeyboardEvent", { value: prevKeyboardEvent, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: prevHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "Node", { value: prevNode, configurable: true });
    Object.defineProperty(globalThis, "requestAnimationFrame", { value: prevRaf, configurable: true });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { value: prevCancelRaf, configurable: true });
    dom.window.close();
  }
});

const snippetsManagerSource = readFileSync(new URL("./SnippetsManager.tsx", import.meta.url), "utf8");

test("vault snippet package and snippet cards use asChild context-menu triggers", () => {
  assert.equal(snippetsManagerSource.match(/<ContextMenuTrigger asChild>/g)?.length, 2);
  assert.doesNotMatch(snippetsManagerSource, /<ContextMenuTrigger>(?! asChild)/);
  assert.match(snippetsManagerSource, /from '\.\/ui\/primaryOnlyDrag'/);
  assert.match(snippetsManagerSource, /primaryOnlyDragHandlers/);
  assert.match(snippetsManagerSource, /deleteSnippetPackage/);
  assert.match(snippetsManagerSource, /renameSnippetPackage/);
  assert.match(snippetsManagerSource, /SNIPPET_PACKAGE_PATH_CHANGE_EVENT/);
  assert.match(snippetsManagerSource, /applySnippetPackagePathChange/);
  assert.match(snippetsManagerSource, /setSelectedPackage/);
  assert.match(snippetsManagerSource, /setEditingSnippet/);
  assert.match(snippetsManagerSource, /setIsRenameDialogOpen\(false\)/);
  assert.match(snippetsManagerSource, /setRenamingPackagePath\(null\)/);
  assert.match(snippetsManagerSource, /deleteTarget\?\.type === 'package'/);
  assert.match(snippetsManagerSource, /setDeleteTarget\(null\)/);
});
