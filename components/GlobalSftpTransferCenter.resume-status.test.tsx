import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment } from "./test-support/renderReactDom.tsx";

test("resume from another panel is visible while backend verification is pending", async (t) => {
  const env = installDomEnvironment();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    MutationObserver: env.window.MutationObserver,
    NodeFilter: env.window.NodeFilter,
    HTMLInputElement: env.window.HTMLInputElement,
    Element: env.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperties(env.window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 460 },
    offsetHeight: { configurable: true, get() { return this.dataset.section === "global-sftp-transfer-list" ? 460 : 112; } },
  });
  const { I18nProvider } = await import("../application/i18n/I18nProvider.tsx");
  const { sftpTransferCenterStore: store } = await import("../application/state/sftpTransferCenterStore.ts");
  const { GlobalSftpTransferCenter } = await import("./GlobalSftpTransferCenter.tsx");
  const { TooltipProvider } = await import("./ui/tooltip.tsx");
  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    env.cleanup();
  });
  let settleResume!: (result: { success: boolean }) => void;
  let resumeCalls = 0;
  const gate = new Promise<{ success: boolean }>((resolve) => { settleResume = resolve; });
  Object.defineProperty(env.window, "netcatty", { configurable: true, value: {
    resumeTransfer: async () => { resumeCalls += 1; return gate; },
  } });
  store.publishOwner("resume-display-test", [{
    id: "resume-display", fileName: "resume-display.bin",
    sourcePath: "/source.bin", targetPath: "/target.bin",
    sourceConnectionId: "remote", targetConnectionId: "local", direction: "download",
    status: "paused", totalBytes: 1000, transferredBytes: 100, speed: 0,
    startTime: 1, isDirectory: false, resumable: true,
  }]);
  await renderer.render(<I18nProvider locale="en"><TooltipProvider><GlobalSftpTransferCenter /></TooltipProvider></I18nProvider>);
  const toggle = env.document.querySelector("[data-section=global-sftp-transfer-toggle]");
  assert.ok(toggle);
  await dispatchDomEvent(toggle, new env.window.MouseEvent("click", { bubbles: true }));
  let resumed!: Promise<void>;
  await act(async () => { resumed = store.resume("resume-display"); });
  try {
    await flushEffects();
    assert.equal(resumeCalls, 1);
    const row = env.document.querySelector('[role=progressbar][aria-label="resume-display.bin"]')?.closest('[data-transfer-status]');
    assert.ok(row);
    assert.match(row.textContent ?? "", /Reconnecting and resuming/);
    assert.equal(row.querySelector('button[aria-label="Resume"]'), null);
  } finally {
    await act(async () => { settleResume({ success: true }); await resumed; });
    await dispatchDomEvent(toggle, new env.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
  }
});
