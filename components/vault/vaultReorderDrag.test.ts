import test from "node:test";
import assert from "node:assert/strict";

import {
  getVaultDropIntent,
  getVaultDropPosition,
  handleVaultHostDropToGroup,
  handleVaultRootDrop,
} from "./vaultReorderDrag.ts";

const makeElement = (rect: Partial<DOMRect>): HTMLElement => ({
  getBoundingClientRect: () => ({
    left: 100,
    right: 200,
    top: 40,
    bottom: 100,
    width: 100,
    height: 60,
    x: 100,
    y: 40,
    toJSON: () => ({}),
    ...rect,
  }),
}) as HTMLElement;

test("vault drop position uses horizontal halves in grid and vertical halves in list", () => {
  const element = makeElement({});

  assert.equal(getVaultDropPosition(element, 120, 90, true), "before");
  assert.equal(getVaultDropPosition(element, 180, 50, true), "after");
  assert.equal(getVaultDropPosition(element, 180, 50, false), "before");
  assert.equal(getVaultDropPosition(element, 120, 90, false), "after");
});

test("vault drop intent uses edges for sorting and middle for nesting", () => {
  const element = makeElement({});

  assert.equal(getVaultDropIntent(element, 110, 70, true), "before");
  assert.equal(getVaultDropIntent(element, 190, 70, true), "after");
  assert.equal(getVaultDropIntent(element, 150, 70, true), "inside");
  assert.equal(getVaultDropIntent(element, 150, 45, false), "before");
  assert.equal(getVaultDropIntent(element, 150, 95, false), "after");
  assert.equal(getVaultDropIntent(element, 150, 70, false), "inside");
});

test("root host drop resets host drag state after moving the host to all hosts", () => {
  const calls: string[] = [];

  handleVaultRootDrop({
    dataTransfer: {
      getData: (type: string) => (type === "host-id" ? "host-1" : ""),
    },
    preventDefault: () => calls.push("preventDefault"),
    setDragOverDropTarget: (target) => calls.push(`drop:${String(target)}`),
    moveGroup: (groupPath, targetPath) => {
      calls.push(`group:${groupPath}:${String(targetPath)}`);
    },
    moveHostToGroup: (hostId, targetPath) => {
      calls.push(`host:${hostId}:${String(targetPath)}`);
    },
    resetHostDragState: () => calls.push("resetHostDragState"),
  });

  assert.deepEqual(calls, [
    "preventDefault",
    "drop:null",
    "host:host-1:null",
    "resetHostDragState",
  ]);
});

test("root group drop moves the group to all hosts without resetting host drag state", () => {
  const calls: string[] = [];

  handleVaultRootDrop({
    dataTransfer: {
      getData: (type: string) => (type === "group-path" ? "team/prod" : ""),
    },
    preventDefault: () => calls.push("preventDefault"),
    setDragOverDropTarget: (target) => calls.push(`drop:${String(target)}`),
    moveGroup: (groupPath, targetPath) => {
      calls.push(`group:${groupPath}:${String(targetPath)}`);
    },
    moveHostToGroup: (hostId, targetPath) => {
      calls.push(`host:${hostId}:${String(targetPath)}`);
    },
    resetHostDragState: () => calls.push("resetHostDragState"),
  });

  assert.deepEqual(calls, [
    "preventDefault",
    "drop:null",
    "group:team/prod:null",
  ]);
});

test("group host drop resets host drag state after moving the host to the group", () => {
  const calls: string[] = [];

  const handled = handleVaultHostDropToGroup({
    dataTransfer: {
      getData: (type: string) => (type === "host-id" ? "host-1" : ""),
    },
    groupPath: "team/prod",
    moveHostToGroup: (hostId, targetPath) => {
      calls.push(`host:${hostId}:${String(targetPath)}`);
    },
    resetHostDragState: () => calls.push("resetHostDragState"),
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    "host:host-1:team/prod",
    "resetHostDragState",
  ]);
});

test("group drop without a host leaves host drag state alone", () => {
  const calls: string[] = [];

  const handled = handleVaultHostDropToGroup({
    dataTransfer: {
      getData: () => "",
    },
    groupPath: "team/prod",
    moveHostToGroup: (hostId, targetPath) => {
      calls.push(`host:${hostId}:${String(targetPath)}`);
    },
    resetHostDragState: () => calls.push("resetHostDragState"),
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
});
