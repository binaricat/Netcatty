import test from "node:test";
import assert from "node:assert/strict";
import React from "react";

import {
  createDomRenderer,
  dispatchDomEvent,
  flushEffects,
  installDomEnvironment,
} from "../test-support/renderReactDom.tsx";

const cases = [
  { name: "file", isDirectory: false, existingType: "file", action: "replace", label: "Replace" },
  { name: "folder", isDirectory: true, existingType: "directory", action: "merge", label: "Merge" },
  { name: "folder with a file target", isDirectory: true, existingType: "file", action: "duplicate", label: "Duplicate" },
  { name: "folder with unknown target type", isDirectory: true, existingType: undefined, action: "duplicate", label: "Duplicate" },
  { name: "legacy file with unknown target type", isDirectory: false, existingType: undefined, action: "duplicate", label: "Duplicate" },
] as const;

for (const scenario of cases) {
  test(`initial ${scenario.name} conflict focuses ${scenario.label} and runs that action`, async (t) => {
    const env = installDomEnvironment();
    const previousMutationObserver = globalThis.MutationObserver;
    const previousNodeFilter = globalThis.NodeFilter;
    const previousHTMLInputElement = globalThis.HTMLInputElement;
    Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: env.window.MutationObserver });
    Object.defineProperty(globalThis, "NodeFilter", { configurable: true, writable: true, value: env.window.NodeFilter });
    Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, writable: true, value: env.window.HTMLInputElement });
    const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
    const { SftpConflictDialog } = await import("./SftpConflictDialog.tsx");
    const renderer = await createDomRenderer(env.document);
    const resolved: Array<{ id: string; action: string }> = [];
    t.after(async () => {
      await renderer.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: previousMutationObserver });
      Object.defineProperty(globalThis, "NodeFilter", { configurable: true, writable: true, value: previousNodeFilter });
      Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, writable: true, value: previousHTMLInputElement });
      env.cleanup();
    });

    await renderer.render(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(SftpConflictDialog, {
        conflicts: [{
          transferId: scenario.name,
          fileName: "test.txt",
          sourcePath: "/src/test.txt",
          targetPath: "/dst/test.txt",
          isDirectory: scenario.isDirectory,
          existingType: scenario.existingType,
          existingSize: 1,
          newSize: 2,
          existingModified: 1,
          newModified: 2,
        }],
        onResolve: (id, action) => resolved.push({ id, action }),
        formatFileSize: (size: number) => `${size} B`,
      }),
    ));
    await flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const focused = env.document.activeElement;
    assert.equal(focused?.textContent, scenario.label);
    assert.ok(focused, "a conflict action should receive focus");
    await dispatchDomEvent(focused, new env.window.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(resolved, [{ id: scenario.name, action: scenario.action }]);
  });
}
