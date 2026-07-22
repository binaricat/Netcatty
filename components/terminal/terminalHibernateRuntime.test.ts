import assert from "node:assert/strict";
import test from "node:test";
import { buildTerminalContextSnapshotText } from "../../domain/terminalContextRead.ts";

import {
  applyAuthoritativeHibernateSnapshot,
  isTerminalAlternateScreenActive,
  readTerminalHibernateContext,
  refreshTerminalViewport,
  resolveHibernateSerializeOptions,
  resolveTerminalSnapshotCapture,
  serializeTerminalForHibernate,
} from "./terminalHibernateRuntime.ts";

test("authoritative empty snapshots clear every hibernated copy", () => {
  const ref = <T>(current: T) => ({ current });
  const refs = {
    snapshot: ref("old snapshot"),
    viewportSnapshot: ref("old viewport"),
    scrollbackSnapshot: ref("old scrollback"),
    contextSnapshot: ref("old context"),
    contextViewportSnapshot: ref("old context viewport"),
    contextScrollbackSnapshot: ref("old context scrollback"),
    pendingBuffer: ref("old pending"),
    alternateScreen: ref(true),
  };

  applyAuthoritativeHibernateSnapshot(refs, "", {
    contextSnapshot: "",
    contextViewportSnapshot: "",
    contextScrollbackSnapshot: "",
    alternateScreen: false,
  });

  assert.deepEqual(Object.fromEntries(
    Object.entries(refs).map(([key, value]) => [key, value.current]),
  ), {
    snapshot: "",
    viewportSnapshot: "",
    scrollbackSnapshot: "",
    contextSnapshot: "",
    contextViewportSnapshot: "",
    contextScrollbackSnapshot: "",
    pendingBuffer: "",
    alternateScreen: false,
  });
});

test("authoritative non-empty snapshots keep readable hibernated context", () => {
  const ref = <T>(current: T) => ({ current });
  const refs = {
    snapshot: ref(""),
    viewportSnapshot: ref(""),
    scrollbackSnapshot: ref("old scrollback"),
    contextSnapshot: ref("old context"),
    contextViewportSnapshot: ref("old context viewport"),
    contextScrollbackSnapshot: ref("old context scrollback"),
    pendingBuffer: ref("old pending"),
    alternateScreen: ref(true),
  };
  const serialized = "\x1b[31mleft\x1b[4Cright\x1b[0m";
  const context = {
    contextSnapshot: "history\nleft    right",
    contextViewportSnapshot: "left    right",
    contextScrollbackSnapshot: "history",
    alternateScreen: true,
  };

  applyAuthoritativeHibernateSnapshot(refs, serialized, context);

  assert.equal(refs.snapshot.current, serialized);
  assert.equal(refs.viewportSnapshot.current, serialized);
  assert.equal(refs.scrollbackSnapshot.current, "");
  assert.equal(refs.contextSnapshot.current, context.contextSnapshot);
  assert.equal(refs.contextViewportSnapshot.current, context.contextViewportSnapshot);
  assert.equal(refs.contextScrollbackSnapshot.current, context.contextScrollbackSnapshot);
  assert.equal(refs.pendingBuffer.current, "");
  assert.equal(refs.alternateScreen.current, true);
});

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

test("readTerminalHibernateContext uses rendered buffer text instead of replay control sequences", () => {
  const term = createFakeTerm("normal", 3, 5);
  const context = readTerminalHibernateContext(term as never);
  assert.equal(context.contextScrollbackSnapshot, "screen-0\nscreen-1");
  assert.equal(context.contextViewportSnapshot, "screen-2\nscreen-3\nscreen-4");
  assert.equal(context.contextSnapshot, "screen-0\nscreen-1\nscreen-2\nscreen-3\nscreen-4");
});

test("readTerminalHibernateContext preserves a scrolled viewport separately from full context", () => {
  const term = createFakeTerm("normal", 3, 7);
  Object.assign(term.buffer.active, { viewportY: 2 });
  const context = readTerminalHibernateContext(term as never);
  assert.equal(context.contextSnapshot, Array.from({ length: 7 }, (_, index) => `screen-${index}`).join("\n"));
  assert.equal(context.contextScrollbackSnapshot, "screen-0\nscreen-1");
  assert.equal(context.contextViewportSnapshot, "screen-2\nscreen-3\nscreen-4");
  assert.equal(context.alternateScreen, false);
});

test("readTerminalHibernateContext marks alternate-screen viewport context", () => {
  const term = createFakeTerm("alternate", 3, 3);
  assert.deepEqual(readTerminalHibernateContext(term as never), {
    contextSnapshot: "screen-0\nscreen-1\nscreen-2",
    contextViewportSnapshot: "screen-0\nscreen-1\nscreen-2",
    contextScrollbackSnapshot: "",
    alternateScreen: true,
  });
});

test("readTerminalHibernateContext treats an all-empty buffer as no readable context", () => {
  const term = createFakeTerm("normal", 3, 3);
  Object.assign(term.buffer.active, {
    getLine() {
      return { translateToString: () => "" };
    },
  });
  assert.deepEqual(readTerminalHibernateContext(term as never), {
    contextSnapshot: "",
    contextViewportSnapshot: "",
    contextScrollbackSnapshot: "",
    alternateScreen: false,
  });
});

test("readTerminalHibernateContext preserves blank scrollback line boundaries", () => {
  const lines = ["", "", "v1", "v2", "v3"];
  const term = createFakeTerm("normal", 3, lines.length);
  Object.assign(term.buffer.active, {
    viewportY: 2,
    getLine(index: number) {
      return { translateToString: () => lines[index] ?? "" };
    },
  });
  const context = readTerminalHibernateContext(term as never);
  assert.equal(context.contextSnapshot, "\n\nv1\nv2\nv3");
  assert.equal(context.contextScrollbackSnapshot, "\n");
  assert.equal(context.contextViewportSnapshot, "v1\nv2\nv3");
  assert.deepEqual(buildTerminalContextSnapshotText({
    scrollbackText: context.contextScrollbackSnapshot,
    viewportText: context.contextViewportSnapshot,
    pendingText: "",
  }), {
    fullText: "\n\nv1\nv2\nv3",
    viewportStartLine: 2,
    viewportEndLine: 4,
  });
});

test("readTerminalHibernateContext preserves an empty viewport after readable history", () => {
  const lines = ["history", "", "", ""];
  const term = createFakeTerm("normal", 3, lines.length);
  Object.assign(term.buffer.active, {
    viewportY: 1,
    getLine(index: number) {
      return { translateToString: () => lines[index] ?? "" };
    },
  });
  const context = readTerminalHibernateContext(term as never);
  assert.equal(context.contextSnapshot, "history\n\n\n");
  assert.equal(context.contextScrollbackSnapshot, "history");
  assert.equal(context.contextViewportSnapshot, "\n\n");
  assert.equal(buildTerminalContextSnapshotText({
    scrollbackText: context.contextScrollbackSnapshot,
    viewportText: context.contextViewportSnapshot,
    pendingText: "",
  }).viewportStartLine, 1);
});

test("resolveTerminalSnapshotCapture falls back for missing serializers and preserves alternate mode", () => {
  const context = {
    contextSnapshot: "old\nscreen",
    contextViewportSnapshot: "screen",
    contextScrollbackSnapshot: "old",
    alternateScreen: true,
  };
  assert.deepEqual(resolveTerminalSnapshotCapture(undefined, context), {
    snapshot: "\x1b[?1049h\x1b[Hscreen",
    context,
  });
  assert.equal(resolveTerminalSnapshotCapture("", context).snapshot, "");
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

test("serializeTerminalForHibernate keeps visual capture when context buffer reading fails", async () => {
  const term = createFakeTerm("normal", 3, 3);
  Object.assign(term.buffer.active, {
    getLine() {
      throw new Error("buffer unavailable");
    },
  });
  const result = await serializeTerminalForHibernate(term as never, {
    serialize: () => "serialized",
  } as never);
  assert.equal(result.snapshot, "serialized");
  assert.equal(result.contextSnapshot, "");
  assert.equal(result.contextViewportSnapshot, "");
  assert.equal(result.contextScrollbackSnapshot, "");
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
