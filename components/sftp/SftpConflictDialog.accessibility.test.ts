import test from "node:test";
import assert from "node:assert/strict";
import React from "react";

import {
  createDomRenderer,
  dispatchDomEvent,
  flushEffects,
  installDomEnvironment,
} from "../test-support/renderReactDom.tsx";

test("announces folder replacement risk and refocuses Merge for each queued conflict", async (t) => {
  const env = installDomEnvironment();
  const previousMutationObserver = globalThis.MutationObserver;
  const previousNodeFilter = globalThis.NodeFilter;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    writable: true,
    value: env.window.MutationObserver,
  });
  Object.defineProperty(globalThis, "NodeFilter", {
    configurable: true,
    writable: true,
    value: env.window.NodeFilter,
  });
  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    writable: true,
    value: env.window.HTMLInputElement,
  });
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { SftpConflictDialog } = await import("./SftpConflictDialog.tsx");
  const renderer = await createDomRenderer(env.document);
  const resolvedActions: string[] = [];
  t.after(async () => {
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      writable: true,
      value: previousMutationObserver,
    });
    Object.defineProperty(globalThis, "NodeFilter", {
      configurable: true,
      writable: true,
      value: previousNodeFilter,
    });
    Object.defineProperty(globalThis, "HTMLInputElement", {
      configurable: true,
      writable: true,
      value: previousHTMLInputElement,
    });
    env.cleanup();
  });

  const queuedConflicts = [
    {
        transferId: "folder-conflict",
        fileName: "docs",
        sourcePath: "/source/docs",
        targetPath: "/destination/docs",
        isDirectory: true,
        existingType: "directory",
        existingSize: 4096,
        newSize: 4096,
        existingModified: 1,
        newModified: 2,
      },
      {
        transferId: "next-folder-conflict",
        fileName: "photos",
        sourcePath: "/source/photos",
        targetPath: "/destination/photos",
        isDirectory: true,
        existingType: "directory",
        existingSize: 4096,
        newSize: 4096,
        existingModified: 3,
        newModified: 4,
      },
      {
        transferId: "symlink-folder-conflict",
        fileName: "shortcut",
        sourcePath: "/source/shortcut",
        targetPath: "/destination/shortcut",
        isDirectory: true,
        existingType: "symlink",
        existingSize: 0,
        newSize: 4096,
        existingModified: 5,
        newModified: 6,
      },
      {
        transferId: "file-folder-conflict",
        fileName: "archive",
        sourcePath: "/source/archive",
        targetPath: "/destination/archive",
        isDirectory: true,
        existingType: "file",
        existingSize: 1024,
        newSize: 4096,
        existingModified: 7,
        newModified: 8,
      },
      {
        transferId: "legacy-folder-conflict",
        fileName: "legacy",
        sourcePath: "/source/legacy",
        targetPath: "/destination/legacy",
        isDirectory: true,
        existingType: undefined,
        existingSize: 0,
        newSize: 4096,
        existingModified: 9,
        newModified: 10,
      },
      {
        transferId: "file-conflict",
        fileName: "notes.txt",
        sourcePath: "/source/notes.txt",
        targetPath: "/destination/notes.txt",
        isDirectory: false,
        existingType: "file",
        existingSize: 128,
        newSize: 256,
        existingModified: 11,
        newModified: 12,
      },
  ] satisfies React.ComponentProps<typeof SftpConflictDialog>["conflicts"];
  const QueueHarness = () => {
    const [conflicts, setConflicts] = React.useState(queuedConflicts);
    return React.createElement(SftpConflictDialog, {
      conflicts,
      onResolve: (_id, action) => {
        resolvedActions.push(action);
        setConflicts((current) => current.slice(1));
      },
      formatFileSize: (size: number) => `${size} B`,
    });
  };

  await renderer.render(React.createElement(
    I18nProvider,
    { locale: "en" },
    React.createElement(QueueHarness),
  ));
  await flushEffects();

  const dialog = env.document.querySelector<HTMLElement>("[role=dialog]");
  assert.ok(dialog, "folder conflict dialog should render");
  const describedBy = dialog.getAttribute("aria-describedby");
  assert.ok(describedBy, "dialog should expose its safety description");
  const describedText = describedBy
    .split(/\s+/)
    .map((id) => env.document.getElementById(id)?.textContent ?? "")
    .join(" ");
  assert.match(describedText, /Merge: keeps destination-only content/);
  assert.match(describedText, /Replace: deletes destination-only content and cannot be undone/);
  assert.doesNotMatch(env.document.body.textContent ?? "", /A folder with the same name already exists/);
  const dialogTitle = env.document.querySelector("[role=dialog] h2");
  assert.equal(dialogTitle?.textContent, "docs already exists");
  assert.equal(dialogTitle?.getAttribute("aria-label"), "Folder Conflict: docs already exists");
  const warning = env.document.getElementById(describedBy.split(/\s+/).at(-1) ?? "");
  assert.ok(warning, "folder action guidance should render");
  assert.equal(warning.querySelectorAll("svg").length, 2, "both guidance rows should use matching icons");
  assert.equal(warning.querySelectorAll("p.text-xs").length, 0, "guidance rows should use the same text size");

  const replaceButton = Array.from(env.document.querySelectorAll("button"))
    .find((button) => button.textContent === "Replace");
  assert.ok(replaceButton, "folder replacement action should render");
  const mergeButton = Array.from(env.document.querySelectorAll("button"))
    .find((button) => button.textContent === "Merge");
  assert.ok(mergeButton, "folder merge action should render");
  assert.match(mergeButton.className, /bg-primary/);
  assert.match(mergeButton.className, /border/);
  assert.doesNotMatch(replaceButton.className, /(^|\s)bg-destructive(?:\s|$)/);
  assert.match(replaceButton.className, /text-destructive/);
  assert.match(replaceButton.className, /border/);
  assert.equal(replaceButton.getAttribute("aria-describedby"), describedBy.split(/\s+/).at(-1));
  for (const label of ["Stop", "Skip", "Duplicate", "Merge", "Replace"]) {
    const action = Array.from(env.document.querySelectorAll("button"))
      .find((button) => button.textContent === label);
    assert.ok(action, `${label} action should render`);
    assert.match(action.className, /h-9/);
    assert.match(action.className, /min-w-24/);
    assert.match(action.className, /border/);
  }
  assert.equal(
    Array.from(env.document.querySelectorAll("button"))
      .filter((button) => button.className.includes("bg-primary"))
      .length,
    1,
    "Merge should be the only visually primary action",
  );
  await dispatchDomEvent(replaceButton, new env.window.MouseEvent("click", { bubbles: true }));
  await flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(resolvedActions, ["replace"]);
  assert.match(env.document.body.textContent ?? "", /photos/);
  assert.equal(env.document.activeElement?.textContent, "Merge");

  const clickFocusedAction = async (expectedLabel: string) => {
    const focusedButton = env.document.activeElement;
    assert.equal(focusedButton?.textContent, expectedLabel);
    assert.ok(focusedButton, `${expectedLabel} should be focused`);
    await dispatchDomEvent(focusedButton, new env.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  await clickFocusedAction("Merge");
  assert.match(env.document.body.textContent ?? "", /shortcut/);
  assert.equal(env.document.activeElement?.textContent, "Replace");

  await clickFocusedAction("Replace");
  assert.match(env.document.body.textContent ?? "", /archive/);
  assert.equal(env.document.activeElement?.textContent, "Duplicate");

  await clickFocusedAction("Duplicate");
  assert.match(env.document.body.textContent ?? "", /legacy/);
  assert.match(env.document.body.textContent ?? "", /type could not be confirmed/);
  assert.equal(env.document.activeElement?.textContent, "Duplicate");
  assert.equal(
    Array.from(env.document.querySelectorAll("button")).some((button) => button.textContent === "Replace"),
    false,
  );

  await clickFocusedAction("Duplicate");
  assert.match(env.document.body.textContent ?? "", /notes\.txt/);
  assert.equal(env.document.activeElement?.textContent, "Replace");

  await clickFocusedAction("Replace");
  assert.deepEqual(resolvedActions, ["replace", "merge", "replace", "duplicate", "duplicate", "replace"]);
  assert.equal(env.document.querySelector("[role=dialog]"), null);
});
