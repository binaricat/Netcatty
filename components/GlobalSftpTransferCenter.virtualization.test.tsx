import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment, runWithAct } from "./test-support/renderReactDom.tsx";

test("large transfer histories mount only visible rows and can scroll to the last file", async (t) => {
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
  store.publishOwner("virtual-list-test", Array.from({ length: 1_000 }, (_, index) => ({
    id: `virtual-file-${index}`, fileName: `file-${index}.bin`,
    sourcePath: `/source/${index}`, targetPath: `/target/${index}`,
    sourceConnectionId: "source", targetConnectionId: "local", direction: "download" as const,
    status: "queued" as const, totalBytes: 1_000, transferredBytes: 0, speed: 0,
    startTime: index + 1, isDirectory: false,
  })));
  await renderer.render(<I18nProvider locale="en"><TooltipProvider><GlobalSftpTransferCenter /></TooltipProvider></I18nProvider>);
  const toggle = env.document.querySelector("[data-section=global-sftp-transfer-toggle]");
  assert.ok(toggle);
  await dispatchDomEvent(toggle, new env.window.MouseEvent("click", { bubbles: true }));
  await flushEffects();
  const rows = () => env.document.querySelectorAll("[role=progressbar]");
  assert.ok(rows().length > 0 && rows().length < 40, `rendered ${rows().length} rows`);
  assert.ok(env.document.querySelector('[role=progressbar][aria-label="file-999.bin"]'));
  const firstRow = env.document.querySelector('[data-transfer-status="queued"]');
  assert.ok(firstRow);
  assert.equal(firstRow.matches('.last\\:border-b-0:last-child'), false, "a virtual row must not lose its divider just because it has a wrapper");

  const scroll = env.document.querySelector<HTMLElement>("[data-section=global-sftp-transfer-list]");
  assert.ok(scroll);
  scroll.scrollTop = 112 * 1_000 - 460;
  await dispatchDomEvent(scroll, new env.window.Event("scroll"));
  await flushEffects();
  assert.ok(rows().length > 0 && rows().length < 40);
  assert.ok(env.document.querySelector('[role=progressbar][aria-label="file-0.bin"]'));
  const lastRow = env.document.querySelector('[role=progressbar][aria-label="file-0.bin"]')?.closest('[data-transfer-status]');
  assert.ok(lastRow?.classList.contains("border-b-0"), "only the actual final row omits its divider");
  assert.equal(store.getSnapshot().tasks.length, 1_000, "offscreen files must remain queued");
  await runWithAct(() => {
    store.patchTask("virtual-file-999", { isDirectory: true, progressMode: "files" });
    store.upsertTasks(Array.from({ length: 100 }, (_, index) => ({
      id: `nested-file-${index}`, fileName: `nested-${index}.bin`,
      sourcePath: `/source/999/${index}`, targetPath: `/target/999/${index}`,
      sourceConnectionId: "source", targetConnectionId: "local", direction: "download" as const,
      status: "queued" as const, totalBytes: 1_000, transferredBytes: 0, speed: 0,
      startTime: index + 2_000, isDirectory: false, parentTaskId: "virtual-file-999",
    })));
  });
  scroll.scrollTop = 0;
  await dispatchDomEvent(scroll, new env.window.Event("scroll"));
  await flushEffects();
  const expand = env.document.querySelector('button[aria-label="Show files"]');
  assert.ok(expand);
  await dispatchDomEvent(expand, new env.window.MouseEvent("click", { bubbles: true }));
  await flushEffects();
  assert.ok(env.document.querySelector('[data-section="global-sftp-transfer-child-list"]'));
  scroll.scrollTop = 112 * 1_000 - 460;
  await dispatchDomEvent(scroll, new env.window.Event("scroll"));
  await flushEffects();
  scroll.scrollTop = 0;
  await dispatchDomEvent(scroll, new env.window.Event("scroll"));
  await flushEffects();
  assert.ok(env.document.querySelector('button[aria-label="Hide files"]'), "folder expansion survives top-level row recycling");
  assert.ok(env.document.querySelector('[data-section="global-sftp-transfer-child-list"]'));

  await dispatchDomEvent(toggle, new env.window.MouseEvent("click", { bubbles: true }));
  await flushEffects();
});
