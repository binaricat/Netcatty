import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalAlternateScreenActive,
  refreshTerminalViewport,
  resolveHibernateSerializeOptions,
  serializeTerminalForHibernate,
} from "./terminalHibernateRuntime.ts";

const createFakeTerm = (bufferType: "normal" | "alternate", rows = 24, length = 30) => ({
  rows,
  cols: 80,
  buffer: {
    active: {
      type: bufferType,
      length,
      getLine(index: number) {
        return {
          translateToString: () => `screen-${index}`,
        };
      },
    },
  },
});

test("resolveHibernateSerializeOptions keeps alt buffer and modes for full-screen apps", () => {
  const term = createFakeTerm("alternate");
  assert.equal(isTerminalAlternateScreenActive(term as never), true);
  assert.deepEqual(resolveHibernateSerializeOptions(term as never), {
    excludeAltBuffer: false,
    excludeModes: false,
    alternateScreen: true,
  });
});

test("resolveHibernateSerializeOptions excludes alt buffer on the normal screen", () => {
  const term = createFakeTerm("normal");
  assert.equal(isTerminalAlternateScreenActive(term as never), false);
  assert.deepEqual(resolveHibernateSerializeOptions(term as never), {
    excludeAltBuffer: true,
    excludeModes: true,
    alternateScreen: false,
  });
});

test("refreshTerminalViewport skips refresh when the terminal has no rows", () => {
  const term = {
    rows: 0,
    refresh: () => {
      throw new Error("refresh should not be called");
    },
  };
  refreshTerminalViewport(term as never);
});

test("refreshTerminalViewport refreshes the full viewport", () => {
  let refreshed: [number, number] | null = null;
  const term = {
    rows: 24,
    refresh: (start: number, end: number) => {
      refreshed = [start, end];
    },
  };
  refreshTerminalViewport(term as never);
  assert.deepEqual(refreshed, [0, 23]);
});

test("serializeTerminalForHibernate preserves alternate screen when serialize throws", async () => {
  const term = createFakeTerm("alternate");
  const serializeAddon = {
    serialize: () => {
      throw new Error("serialize failed");
    },
  };
  const result = await serializeTerminalForHibernate(term as never, serializeAddon as never);
  assert.equal(result.snapshot, "");
  assert.equal(result.viewportSnapshot, "");
  assert.equal(result.scrollbackSnapshot, "");
  assert.equal(result.contextViewportSnapshot?.startsWith("screen-0\nscreen-1"), true);
  assert.equal(result.alternateScreen, true);
});

test("serializeTerminalForHibernate requests viewport-only range on alternate screen", async () => {
  let capturedOptions: Record<string, unknown> | undefined;
  const term = createFakeTerm("alternate", 24);
  const serializeAddon = {
    serialize: (options?: Record<string, unknown>) => {
      capturedOptions = options;
      return "alt-viewport";
    },
  };
  const result = await serializeTerminalForHibernate(term as never, serializeAddon as never);
  assert.equal(result.snapshot, "alt-viewport");
  assert.equal(result.contextViewportSnapshot, Array.from({ length: 24 }, (_, index) => `screen-${index}`).join("\n"));
  assert.deepEqual(capturedOptions?.range, { start: 0, end: 23 });
});

test("serializeTerminalForHibernate preserves plain text context for normal screen", async () => {
  const capturedRanges: unknown[] = [];
  const term = createFakeTerm("normal", 3, 5);
  const serializeAddon = {
    serialize: (options?: Record<string, unknown>) => {
      capturedRanges.push(options?.range);
      return "serialized";
    },
  };
  const result = await serializeTerminalForHibernate(term as never, serializeAddon as never);
  assert.equal(result.viewportSnapshot, "serialized");
  assert.equal(result.scrollbackSnapshot, "serialized");
  assert.equal(result.contextScrollbackSnapshot, "screen-0\nscreen-1");
  assert.equal(result.contextViewportSnapshot, "screen-2\nscreen-3\nscreen-4");
  assert.equal(result.contextSnapshot, "screen-0\nscreen-1\nscreen-2\nscreen-3\nscreen-4");
  assert.deepEqual(capturedRanges, [
    { start: 2, end: 4 },
    { start: 0, end: 1 },
    undefined,
  ]);
});
