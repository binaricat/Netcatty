import test from "node:test";
import assert from "node:assert/strict";

import {
  applyUserCursorBlinkPreference,
  applyUserCursorPreference,
  installUserCursorPreferenceGuard,
  resolveUserCursorPreference,
} from "./cursorPreference";

test("resolveUserCursorPreference defaults to a blinking block cursor", () => {
  assert.deepEqual(resolveUserCursorPreference(undefined), {
    cursorShape: "block",
    cursorBlink: true,
  });
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
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, undefined);
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, undefined);
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
