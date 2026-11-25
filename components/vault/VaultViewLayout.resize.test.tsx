import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import {
  createDomRenderer,
  dispatchDomEvent,
  installDomEnvironment,
  runWithAct,
} from "../test-support/renderReactDom";
import { useVaultSidebarResize } from "./VaultViewLayout";

function installManualRaf(win: Window & typeof globalThis) {
  let nextId = 1;
  const scheduled = new Map<number, FrameRequestCallback>();
  const cancelledIds: number[] = [];
  let requestCount = 0;

  const originalRequest = win.requestAnimationFrame;
  const originalCancel = win.cancelAnimationFrame;

  win.requestAnimationFrame = (cb: FrameRequestCallback) => {
    requestCount += 1;
    const id = nextId++;
    scheduled.set(id, cb);
    return id;
  };
  win.cancelAnimationFrame = (id: number) => {
    cancelledIds.push(id);
    scheduled.delete(id);
  };

  return {
    get requestCount() {
      return requestCount;
    },
    get pendingCount() {
      return scheduled.size;
    },
    cancelledIds,
    async flushNext() {
      const entries = Array.from(scheduled.entries());
      scheduled.clear();
      await runWithAct(() => {
        for (const [, cb] of entries) cb(16);
      });
    },
    restore() {
      win.requestAnimationFrame = originalRequest;
      win.cancelAnimationFrame = originalCancel;
    },
  };
}

async function setupHarness(t: test.TestContext, initialWidth = 208) {
  const env = installDomEnvironment();
  const raf = installManualRaf(env.window);
  const renderer = await createDomRenderer(env.document);

  const widthUpdates: number[] = [];
  const commits: number[] = [];
  const resizingStates: boolean[] = [];

  function Harness({ width }: { width: number }) {
    const onPointerDown = useVaultSidebarResize({
      effectiveSidebarWidth: width,
      minWidth: 56,
      maxWidth: 320,
      setSidebarWidth: (next) => {
        widthUpdates.push(next);
      },
      handleSidebarWidthCommit: (next) => {
        commits.push(next);
      },
      setIsSidebarResizing: (resizing) => {
        resizingStates.push(resizing);
      },
    });
    return <div role="separator" onPointerDown={onPointerDown} />;
  }

  await renderer.render(<Harness width={initialWidth} />);
  const separator = env.document.querySelector('[role="separator"]')!;
  const pointer = (target: EventTarget, type: string, x: number) =>
    dispatchDomEvent(
      target,
      new env.window.MouseEvent(type, { bubbles: true, clientX: x }),
    );

  t.after(async () => {
    await renderer.unmount();
    raf.restore();
    env.cleanup();
  });

  return {
    env,
    raf,
    widthUpdates,
    commits,
    resizingStates,
    unmount: () => renderer.unmount(),
    start: (x = 200) => pointer(separator, "pointerdown", x),
    move: (x: number) => pointer(env.window, "pointermove", x),
    up: (x: number) => pointer(env.window, "pointerup", x),
    cancel: (x: number) => pointer(env.window, "pointercancel", x),
  };
}

test("VaultViewLayout sidebar resize coalesces pointermove events into a single rAF with the latest width", async (t) => {
  const h = await setupHarness(t, 208);

  await h.start(200);
  await h.move(210); // 218
  await h.move(225); // 233
  await h.move(240); // 248
  await h.move(360); // clamped to 320

  assert.equal(h.raf.requestCount, 1);
  assert.equal(h.raf.pendingCount, 1);
  assert.deepEqual(
    h.widthUpdates,
    [],
    "setSidebarWidth must not fire synchronously on pointermove before rAF",
  );

  await h.raf.flushNext();
  assert.deepEqual(h.widthUpdates, [320]);
  assert.equal(h.raf.pendingCount, 0);

  await h.up(250); // 258
  assert.deepEqual(h.widthUpdates, [320, 258]);
  assert.deepEqual(h.commits, [258]);
  assert.equal(h.env.document.body.style.cursor, "");
  assert.equal(h.env.document.body.style.userSelect, "");
});

test("VaultViewLayout sidebar pointerup cancels pending rAF before committing final width", async (t) => {
  const h = await setupHarness(t, 208);

  await h.start(200);
  await h.move(280); // schedules rAF for 288
  assert.equal(h.raf.pendingCount, 1);

  await h.up(220); // commits 228 before queued rAF runs
  assert.equal(h.raf.cancelledIds.length, 1);
  assert.equal(h.raf.pendingCount, 0);
  assert.deepEqual(h.widthUpdates, [228]);
  assert.deepEqual(h.commits, [228]);
});

test("VaultViewLayout sidebar resize cleans up window listeners, cursor, and pending rAF on unmount", async (t) => {
  const h = await setupHarness(t, 208);

  await h.start(200);
  await h.move(260);
  assert.equal(h.raf.pendingCount, 1);
  assert.equal(h.env.document.body.style.cursor, "col-resize");
  assert.equal(h.env.document.body.style.userSelect, "none");

  await h.unmount();
  assert.equal(h.raf.cancelledIds.length, 1, "unmount must cancel pending rAF");
  assert.equal(h.raf.pendingCount, 0);
  assert.equal(h.env.document.body.style.cursor, "");
  assert.equal(h.env.document.body.style.userSelect, "");

  // Post-unmount window pointer events must not trigger leaked listeners.
  await h.move(300);
  await h.up(300);
  assert.deepEqual(h.widthUpdates, []);
  assert.deepEqual(h.commits, []);
});

test("VaultViewLayout inline panel surface clips enter-animation overflow", () => {
  const source = readFileSync(new URL("./VaultViewLayout.tsx", import.meta.url), "utf8");
  const surfaceIndex = source.indexOf('data-section="vault-surface"');
  assert.ok(surfaceIndex > 0);
  const surfaceOpening = source.slice(Math.max(0, surfaceIndex - 500), surfaceIndex);
  assert.match(surfaceOpening, /overflow-hidden/);
});
