import test from "node:test";
import assert from "node:assert/strict";

import {
  applyUserCursorBlinkPreference,
  applyUserCursorPreference,
  applyUserCursorWidthPreference,
  installUserCursorPreferenceGuard,
  resolveUserCursorPreference,
  shouldApplyUserCursorPreference,
  snapshotUserCursorPreference,
} from "./cursorPreference";

test("resolveUserCursorPreference defaults to a blinking block cursor", () => {
  assert.deepEqual(resolveUserCursorPreference(undefined), {
    cursorShape: "block",
    cursorBlink: true,
    cursorBarWidth: 2,
  });
});

test("shouldApplyUserCursorPreference applies full preferences only for shape or blink changes", () => {
  const previous = snapshotUserCursorPreference({
    cursorShape: "block",
    cursorBlink: true,
  });

  assert.equal(
    shouldApplyUserCursorPreference(previous, snapshotUserCursorPreference({
      cursorShape: "block",
      cursorBlink: true,
      cursorBarWidth: 4,
    })),
    false,
  );
  assert.equal(
    shouldApplyUserCursorPreference(previous, snapshotUserCursorPreference({
      cursorShape: "bar",
      cursorBlink: true,
    })),
    true,
  );
  assert.equal(
    shouldApplyUserCursorPreference(previous, snapshotUserCursorPreference({
      cursorShape: "block",
      cursorBlink: false,
    })),
    true,
  );
});

test("applyUserCursorPreference clears terminal-side cursor overrides before applying user settings", () => {
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: false,
    },
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "bar" as const,
          cursorBlink: false,
        },
      },
    },
  };

  applyUserCursorPreference(term, {
    cursorShape: "underline",
    cursorBlink: true,
  });

  assert.equal(term.options.cursorStyle, "underline");
  assert.equal(term.options.cursorBlink, true);
  assert.equal((term.options as { cursorWidth?: number }).cursorWidth, 2);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, undefined);
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, undefined);
});

test("resolveUserCursorPreference clamps bar cursor width to the supported range", () => {
  assert.equal(resolveUserCursorPreference({ cursorBarWidth: 9 }).cursorBarWidth, 4);
  assert.equal(resolveUserCursorPreference({ cursorBarWidth: 0 }).cursorBarWidth, 1);
});

test("first width update after runtime creation preserves a remote DEC bar cursor", () => {
  const initialSnapshot = snapshotUserCursorPreference({
    cursorShape: "block",
    cursorBlink: true,
    cursorBarWidth: 2,
  });
  const nextSettings = {
    cursorShape: "block" as const,
    cursorBlink: true,
    cursorBarWidth: 3,
  };
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: true,
    },
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "bar" as const,
          cursorBlink: true,
        },
      },
    },
  };

  const nextSnapshot = snapshotUserCursorPreference(nextSettings);
  assert.equal(shouldApplyUserCursorPreference(initialSnapshot, nextSnapshot), false);

  applyUserCursorWidthPreference(term, nextSettings);

  assert.equal((term.options as { cursorWidth?: number }).cursorWidth, 3);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "bar");
});

test("applyUserCursorWidthPreference preserves a remote DEC cursor-style override", () => {
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: true,
    },
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "bar" as const,
          cursorBlink: false,
        },
      },
    },
  };

  applyUserCursorWidthPreference(term, { cursorBarWidth: 3 });

  assert.equal((term.options as { cursorWidth?: number }).cursorWidth, 3);
  assert.equal(term.options.cursorStyle, "block");
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "bar");
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, false);
});

test("width updates preserve a remote DEC underline cursor override", () => {
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: true,
    },
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "underline" as const,
          cursorBlink: false,
        },
      },
    },
  };

  applyUserCursorWidthPreference(term, { cursorBarWidth: 4 });

  assert.equal((term.options as { cursorWidth?: number }).cursorWidth, 4);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "underline");
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, false);
});

test("applyUserCursorBlinkPreference keeps remote cursor shape overrides intact", () => {
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: false,
    },
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "bar" as const,
          cursorBlink: false,
        },
      },
    },
  };

  applyUserCursorBlinkPreference(term, {
    cursorShape: "underline",
    cursorBlink: true,
  });

  assert.equal(term.options.cursorStyle, "block");
  assert.equal(term.options.cursorBlink, true);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "bar");
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, undefined);
});

test("installUserCursorPreferenceGuard restores blink without consuming cursor-style overrides", async () => {
  const handlers = new Map<string, (params: readonly (number | number[])[]) => boolean>();
  const parser = {
    registerCsiHandler(this: typeof parser, id: { prefix?: string; intermediates?: string; final: string }, callback: (params: readonly (number | number[])[]) => boolean) {
      assert.equal(this, parser);
      handlers.set(`${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`, callback);
      return { dispose: () => undefined };
    },
  };
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: false,
    },
    parser,
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "block" as const,
          cursorBlink: false,
        },
      },
    },
  };
  const settingsRef = {
    current: {
      cursorShape: "bar",
      cursorBlink: true,
    },
  };

  installUserCursorPreferenceGuard(term, settingsRef);
  const handled = handlers.get("| |q")?.([2]);

  assert.equal(handled, false);

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.equal(term.options.cursorStyle, "block");
  assert.equal(term.options.cursorBlink, true);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "block");
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, undefined);
});

test("installUserCursorPreferenceGuard restores cursor blink after private mode changes", async () => {
  const handlers = new Map<string, (params: readonly (number | number[])[]) => boolean>();
  const term = {
    options: {
      cursorStyle: "block" as const,
      cursorBlink: false,
    },
    parser: {
      registerCsiHandler: (id: { prefix?: string; intermediates?: string; final: string }, callback: (params: readonly (number | number[])[]) => boolean) => {
        handlers.set(`${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`, callback);
        return { dispose: () => undefined };
      },
    },
    _core: {
      coreService: {
        decPrivateModes: {
          cursorStyle: "block" as const,
          cursorBlink: false,
        },
      },
    },
  };
  const settingsRef = {
    current: {
      cursorShape: "underline",
      cursorBlink: true,
    },
  };

  installUserCursorPreferenceGuard(term, settingsRef);
  const handled = handlers.get("?||l")?.([12]);

  assert.equal(handled, false);

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.equal(term.options.cursorStyle, "block");
  assert.equal(term.options.cursorBlink, true);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "block");
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, undefined);
});
