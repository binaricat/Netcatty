import assert from "node:assert/strict";
import test from "node:test";
import type { MouseEvent as ReactMouseEvent } from "react";
import { JSDOM } from "jsdom";
import type { TransferTask } from "../../../types";

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "CustomEvent",
    "Event",
    "MouseEvent",
    "StorageEvent",
    "DOMException",
  ]) {
    install(key, key === "window" ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install("localStorage", dom.window.localStorage);
  install("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    dom,
    cleanup() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

const makeTask = (id: string, overrides: Partial<TransferTask> = {}): TransferTask => ({
  id,
  fileName: `${id}.bin`,
  sourcePath: `/src/${id}.bin`,
  targetPath: `/dst/${id}.bin`,
  sourceConnectionId: "local",
  targetConnectionId: "remote-1",
  direction: "upload",
  status: "transferring",
  totalBytes: 1000,
  transferredBytes: 100,
  speed: 50,
  startTime: 1000,
  isDirectory: false,
  ...overrides,
});

test("useSftpPaneSorting cleans up document drag listeners and pending rAF if unmounted mid-drag", async () => {
  const env = setupDom();
  const pendingRafs = new Map<number, FrameRequestCallback>();
  let nextRafId = 1;
  const cancelledRafIds: number[] = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextRafId++;
    pendingRafs.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelledRafIds.push(id);
    pendingRafs.delete(id);
  }) as typeof cancelAnimationFrame;

  let docMoveAdds = 0;
  let docMoveRemoves = 0;
  let docUpAdds = 0;
  let docUpRemoves = 0;
  const origDocAdd = document.addEventListener.bind(document);
  const origDocRemove = document.removeEventListener.bind(document);
  document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "mousemove") docMoveAdds += 1;
    if (type === "mouseup") docUpAdds += 1;
    return origDocAdd(type, listener, options);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "mousemove") docMoveRemoves += 1;
    if (type === "mouseup") docUpRemoves += 1;
    return origDocRemove(type, listener, options);
  }) as typeof document.removeEventListener;

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useSftpPaneSorting } = await import("./useSftpPaneSorting");

  let latestResult!: ReturnType<typeof useSftpPaneSorting>;
  function Harness() {
    latestResult = useSftpPaneSorting();
    return <div data-name-width={String(latestResult.columnWidths.name)} />;
  }

  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(<Harness />);
    });

    // 1. Normal drag updates width and cleans up listeners on mouseup.
    await act(async () => {
      latestResult.handleResizeStart("name", {
        preventDefault() {},
        stopPropagation() {},
        clientX: 100,
      } as unknown as ReactMouseEvent);
    });
    assert.equal(docMoveAdds, 1);
    assert.equal(docUpAdds, 1);

    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 180 }));
    });
    assert.equal(pendingRafs.size, 1);
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    assert.equal(docMoveRemoves, 1);
    assert.equal(docUpRemoves, 1);
    assert.equal(pendingRafs.size, 0);
    assert.equal(latestResult.columnWidths.name, 60);

    // 2. Unmounting mid-drag removes both document listeners and cancels pending rAF.
    await act(async () => {
      latestResult.handleResizeStart("name", {
        preventDefault() {},
        stopPropagation() {},
        clientX: 100,
      } as unknown as ReactMouseEvent);
    });
    assert.equal(docMoveAdds, 2);
    assert.equal(docUpAdds, 2);

    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 }));
    });
    assert.equal(pendingRafs.size, 1);
    const queuedRafId = [...pendingRafs.keys()][0];

    await act(async () => {
      root.unmount();
    });
    assert.equal(docMoveRemoves, 2);
    assert.equal(docUpRemoves, 2);
    assert.equal(pendingRafs.size, 0);
    assert.ok(cancelledRafIds.includes(queuedRafId));
  } finally {
    document.addEventListener = origDocAdd;
    document.removeEventListener = origDocRemove;
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancelRaf;
    env.cleanup();
  }
});

test("applyTransferProgressToRows returns same array for unknown taskId and single-slot copies matching rows while honoring pause latch", async () => {
  const { applyTransferProgressToRows } = await import("./useSftpTransfers");

  const row1 = makeTask("task-1", { transferredBytes: 100, speed: 50 });
  const row2 = makeTask("task-2", { transferredBytes: 200, speed: 80 });
  const row3 = makeTask("task-3", { status: "paused", transferredBytes: 300, speed: 0 });
  const rows = [row1, row2, row3];

  // Unknown taskId -> exact same array reference, zero cloning.
  const unchanged = applyTransferProgressToRows(rows, "missing-task", { transferredBytes: 999 }, () => false);
  assert.equal(unchanged, rows);

  // Matching taskId -> shallow single-slot copy preserving untouched row references.
  const updated = applyTransferProgressToRows(rows, "task-2", { transferredBytes: 450, speed: 120 }, () => false);
  assert.notEqual(updated, rows);
  assert.equal(updated[0], row1);
  assert.equal(updated[2], row3);
  assert.notEqual(updated[1], row2);
  assert.equal(updated[1].transferredBytes, 450);
  assert.equal(updated[1].speed, 120);

  // Stale "transferring" progress tick must not reopen a paused or latched row.
  const stillPaused = applyTransferProgressToRows(
    rows,
    "task-3",
    { status: "transferring", transferredBytes: 320, speed: 90 },
    () => false,
  );
  assert.equal(stillPaused[2].status, "paused");
  assert.equal(stillPaused[2].speed, 0);
  assert.equal(stillPaused[2].transferredBytes, 320);

  const latchedRow = applyTransferProgressToRows(
    rows,
    "task-1",
    { status: "transferring", transferredBytes: 150, speed: 75 },
    (rootId, rowId) => rootId === "task-1" && rowId === "task-1",
  );
  assert.equal(latchedRow[0].status, "transferring");
  assert.equal(latchedRow[0].speed, 0);
});
