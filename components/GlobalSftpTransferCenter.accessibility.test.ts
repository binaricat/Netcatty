import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import {
  createDomRenderer,
  dispatchDomEvent,
  flushEffects,
  installDomEnvironment,
} from "./test-support/renderReactDom.tsx";

test("associates the transfer-center folder warning with every destructive Replace action", async (t) => {
  const env = installDomEnvironment();
  const previousMutationObserver = globalThis.MutationObserver;
  const previousNodeFilter = globalThis.NodeFilter;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousElement = globalThis.Element;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  Object.defineProperties(globalThis, {
    MutationObserver: { configurable: true, writable: true, value: env.window.MutationObserver },
    NodeFilter: { configurable: true, writable: true, value: env.window.NodeFilter },
    HTMLInputElement: { configurable: true, writable: true, value: env.window.HTMLInputElement },
    Element: { configurable: true, writable: true, value: env.window.Element },
    requestAnimationFrame: {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    },
    cancelAnimationFrame: { configurable: true, writable: true, value: clearTimeout },
  });

  const { I18nProvider } = await import("../application/i18n/I18nProvider.tsx");
  const { sftpTransferCenterStore } = await import("../application/state/sftpTransferCenterStore.ts");
  const { GlobalSftpTransferCenter } = await import("./GlobalSftpTransferCenter.tsx");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const renderer = await createDomRenderer(env.document);
  const taskId = "accessible-folder-conflict";
  const unregisterOwner = sftpTransferCenterStore.registerOwner("accessibility-test-owner", {
    pause: () => {},
    resume: () => {},
    cancel: () => {},
    retry: () => {},
    prioritize: () => {},
    dismiss: () => {},
    ownsTask: () => true,
    resolveConflict: () => {},
  });
  sftpTransferCenterStore.publishOwner("accessibility-test-owner", [{
    id: taskId,
    fileName: "docs",
    sourcePath: "/source/docs",
    targetPath: "/destination/docs",
    sourceConnectionId: "source",
    targetConnectionId: "target",
    direction: "remote-to-remote",
    status: "attention",
    totalBytes: 0,
    transferredBytes: 0,
    speed: 0,
    startTime: 1,
    isDirectory: true,
    conflict: {
      transferId: taskId,
      fileName: "docs",
      sourcePath: "/source/docs",
      targetPath: "/destination/docs",
      isDirectory: true,
      existingType: "directory",
      applyToAllCount: 2,
      existingSize: 0,
      newSize: 0,
      existingModified: 1,
      newModified: 2,
    },
  }]);

  t.after(async () => {
    await renderer.unmount();
    sftpTransferCenterStore.dismiss(taskId);
    unregisterOwner();
    await new Promise((resolve) => setTimeout(resolve, 50));
    Object.defineProperties(globalThis, {
      MutationObserver: { configurable: true, writable: true, value: previousMutationObserver },
      NodeFilter: { configurable: true, writable: true, value: previousNodeFilter },
      HTMLInputElement: { configurable: true, writable: true, value: previousHTMLInputElement },
      Element: { configurable: true, writable: true, value: previousElement },
      requestAnimationFrame: { configurable: true, writable: true, value: previousRequestAnimationFrame },
      cancelAnimationFrame: { configurable: true, writable: true, value: previousCancelAnimationFrame },
    });
    env.cleanup();
  });

  await renderer.render(React.createElement(
    I18nProvider,
    { locale: "en" },
    React.createElement(TooltipProvider, null, React.createElement(GlobalSftpTransferCenter)),
  ));
  await flushEffects();

  const toggle = env.document.querySelector<HTMLButtonElement>("[data-section=global-sftp-transfer-toggle]");
  assert.ok(toggle, "transfer-center toggle should render");
  await dispatchDomEvent(toggle, new env.window.MouseEvent("click", { bubbles: true }));
  await flushEffects();

  const replaceButtons = Array.from(env.document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => button.textContent?.startsWith("Replace"));
  assert.equal(replaceButtons.length, 2);
  for (const button of replaceButtons) {
    const describedBy = button.getAttribute("aria-describedby");
    assert.ok(describedBy, `${button.textContent} should expose the folder deletion warning`);
    const warning = env.document.getElementById(describedBy);
    assert.match(
      warning?.textContent ?? "",
      /Replace: deletes destination-only content and cannot be undone/,
    );
  }
});
