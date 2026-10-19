import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment, runWithAct } from "./test-support/renderReactDom.tsx";

test("expanded folder history bounds mounted files, isolates progress, and reaches the final child", async (t) => {
  const env = installDomEnvironment();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    MutationObserver: env.window.MutationObserver,
    NodeFilter: env.window.NodeFilter,
    HTMLInputElement: env.window.HTMLInputElement,
    Element: env.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperties(env.window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 460 },
    offsetHeight: { configurable: true, get() { return this.dataset.section === "global-sftp-transfer-child-list" ? 192 : 460; } },
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
  const childCount = 1_000;
  const base = {
    fileName: "folder", sourcePath: "/source", targetPath: "/target",
    sourceConnectionId: "source", targetConnectionId: "local", direction: "download" as const,
    totalBytes: 1_000, transferredBytes: 0, speed: 0, startTime: 1,
  };
  store.publishOwner("children-performance", [
    { ...base, id: "folder", status: "transferring", isDirectory: true, progressMode: "files" },
    ...Array.from({ length: childCount }, (_, index) => ({
      ...base, id: `child-${index}`, fileName: `child-${index}.bin`, sourcePath: `/source/${index}`, targetPath: `/target/${index}`,
      status: index === 0 ? "transferring" as const : "queued" as const,
      startTime: index + 2, isDirectory: false, parentTaskId: "folder",
    })),
  ]);
  await renderer.render(<I18nProvider locale="en"><TooltipProvider><GlobalSftpTransferCenter /></TooltipProvider></I18nProvider>);
  const click = async (selector: string) => {
    const element = env.document.querySelector(selector);
    assert.ok(element, selector);
    await dispatchDomEvent(element, new env.window.MouseEvent("click", { bubbles: true }));
    await flushEffects();
  };
  await click("[data-section=global-sftp-transfer-toggle]");
  await click('button[aria-label="Show files"]');
  const childList = () => env.document.querySelector<HTMLElement>("[data-section=global-sftp-transfer-child-list]");
  const childRows = () => childList()?.querySelectorAll('[data-transfer-status]') ?? [];
  assert.ok(childRows().length > 0 && childRows().length < 40, `mounted ${childRows().length} child rows`);
  assert.match(childList()?.textContent ?? "", /child-0.bin/);

  let orderReads = 0;
  for (const task of store.getSnapshot().tasks) {
    if (!task.parentTaskId) continue;
    const startTime = task.startTime;
    Object.defineProperty(task, "startTime", { configurable: true, enumerable: true, get: () => { orderReads += 1; return startTime; } });
  }
  await runWithAct(async () => {
    store.patchTask("child-0", { transferredBytes: 500, speed: 100 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(orderReads < 20, `one byte update re-sorted the directory (${orderReads} reads)`);
  assert.match(childList()?.textContent ?? "", /500 B/);

  const pauseAll = () => [...env.document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === "Pause all")!;
  assert.equal(pauseAll().disabled, false);
  await runWithAct(async () => {
    store.ingestBackgroundEvent({ type: "progress", transferId: "child-0", transferred: 600, resumable: false, pauseUnavailableReason: "fixture cannot pause" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(store.getTask("folder")?.resumable, false, "a child's backend capability also limits its folder");
  assert.equal(pauseAll().disabled, true, "batch controls must use the current backend capability");
  await runWithAct(async () => {
    store.patchTask("folder", { resumable: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(pauseAll().disabled, false, "metadata-only patches must refresh eligibility too");
  await runWithAct(async () => {
    store.ingestBackgroundEvent({ type: "progress", transferId: "child-0", transferred: 650, resumable: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(pauseAll().disabled, true, "a parent-only capability change is reflected even when the child already reported false");
  await runWithAct(async () => {
    store.patchTask("folder", { resumable: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(pauseAll().disabled, true);
  orderReads = 0;
  await runWithAct(async () => {
    store.ingestBackgroundEvent({ type: "progress", transferId: "child-0", transferred: 700, resumable: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(orderReads < 20, "repeated capability metadata on byte ticks does not re-sort the directory");
  await runWithAct(() => store.publishOwner("failed-control", [{
    ...base, id: "failed-control", status: "failed", isDirectory: false, endTime: Date.now(), resumable: true, checkpointBytes: 0,
  }]));
  const resumeAll = () => [...env.document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === "Resume all")!;
  assert.equal(resumeAll().disabled, true);
  await runWithAct(async () => {
    store.patchTask("failed-control", { checkpointBytes: 20 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(resumeAll().disabled, false, "a newly available failed-task checkpoint enables the existing resume action");

  const list = childList()!;
  list.scrollTop = 24 * childCount - 192;
  await dispatchDomEvent(list, new env.window.Event("scroll"));
  await flushEffects();
  assert.ok(childRows().length > 0 && childRows().length < 40);
  assert.match(childList()?.textContent ?? "", /child-999.bin/);
  await runWithAct(() => store.patchTask("child-999", { status: "completed", transferredBytes: 1_000 }));
  assert.equal(store.getTask("folder")?.directoryResumeCheckpoint?.completedEntries, 1, "completed files remain counted in the existing compact folder checkpoint");
  assert.equal(store.getTask("child-999"), undefined, "the existing completion compaction still owns history retention");
  assert.equal(store.getTask("child-500")?.status, "queued");
  await click('button[aria-label="Hide files"]');
  assert.equal(childList(), null);
  await click('button[aria-label="Show files"]');
  assert.ok(childRows().length > 0 && childRows().length < 40);
  assert.equal(store.getSnapshot().tasks.filter((task) => task.parentTaskId === "folder").length, childCount - 1, "virtualization never drops queued files");
  await runWithAct(() => {
    store.publishOwner("repair-folder", [{ ...base, id: "repair-folder", fileName: "repaired folder", status: "transferring", isDirectory: true }]);
    store.publishOwner("repair-background", [{ ...base, id: "repair-child", fileName: "repaired-child.bin", status: "transferring", isDirectory: false, background: true, transferredBytes: 10 }]);
  });
  const repairedFolderRow = () => [...env.document.querySelectorAll<HTMLElement>('[data-section=global-sftp-transfer-row]')].find((row) => row.textContent?.includes("repaired folder"))!;
  assert.equal(repairedFolderRow().querySelector('button[aria-label="Show files"]'), null);
  await runWithAct(async () => {
    store.ingestBackgroundEvent({ type: "progress", transferId: "repair-child", parentTaskId: "repair-folder", transferred: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const repairedExpand = repairedFolderRow().querySelector('button[aria-label="Show files"]');
  assert.ok(repairedExpand, "same-byte hierarchy repair immediately exposes the folder's child");
  await dispatchDomEvent(repairedExpand, new env.window.MouseEvent("click", { bubbles: true }));
  await flushEffects();
  assert.match(repairedFolderRow().textContent ?? "", /repaired-child.bin/);
  const repairedHierarchy = store.getLifecycleSnapshot();
  await runWithAct(async () => {
    store.ingestBackgroundEvent({ type: "progress", transferId: "repair-child", parentTaskId: "repair-folder", transferred: 11 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(store.getLifecycleSnapshot(), repairedHierarchy);
  assert.match(repairedFolderRow().textContent ?? "", /repaired-child.bin/);
  await click("[data-section=global-sftp-transfer-toggle]");
});
