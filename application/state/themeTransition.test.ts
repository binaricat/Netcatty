import assert from "node:assert/strict";
import test from "node:test";

import {
  THEME_TRANSITION_ATTR,
  THEME_TRANSITION_MS,
  runThemeTransition,
} from "./themeTransition.ts";

function createRoot() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    ownerDocument: { startViewTransition: undefined },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  } as unknown as HTMLElement;
}

test("runThemeTransition applies tokens and clears fallback marker after duration", async () => {
  const root = createRoot();
  let applied = false;

  runThemeTransition(() => {
    applied = true;
  }, root);

  assert.equal(applied, true);
  assert.equal(root.getAttribute(THEME_TRANSITION_ATTR), "true");

  await new Promise((resolve) => setTimeout(resolve, THEME_TRANSITION_MS + 60));
  assert.equal(root.getAttribute(THEME_TRANSITION_ATTR), null);
});

test("runThemeTransition cancels a pending fallback reset when invoked again", () => {
  const root = createRoot();
  let count = 0;

  runThemeTransition(() => {
    count += 1;
  }, root);
  runThemeTransition(() => {
    count += 2;
  }, root);

  assert.equal(count, 3);
  assert.equal(root.getAttribute(THEME_TRANSITION_ATTR), "true");
});

test("runThemeTransition uses view transition API when available", async () => {
  const root = createRoot();
  let applied = false;
  let finished = false;
  const doc = {
    startViewTransition: (callback: () => void) => {
      callback();
      return {
        finished: Promise.resolve().then(() => {
          finished = true;
        }),
        skipTransition: () => {},
      };
    },
  };
  (root as { ownerDocument: typeof doc }).ownerDocument = doc;

  runThemeTransition(() => {
    applied = true;
  }, root);

  assert.equal(applied, true);
  assert.equal(root.getAttribute(THEME_TRANSITION_ATTR), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, true);
});

test("runThemeTransition handles skipped view transitions", async () => {
  const root = createRoot();
  let applied = false;
  let rejectFinished!: (reason: unknown) => void;
  const doc = {
    startViewTransition: (callback: () => void) => {
      callback();
      return {
        finished: new Promise<void>((_, reject) => {
          rejectFinished = reject;
        }),
        skipTransition: () => {},
      };
    },
  };
  (root as { ownerDocument: typeof doc }).ownerDocument = doc;

  runThemeTransition(() => {
    applied = true;
  }, root);

  rejectFinished(new DOMException("Transition was skipped", "AbortError"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(applied, true);
  assert.equal(root.getAttribute(THEME_TRANSITION_ATTR), null);
});

test("runThemeTransition can apply without animation for heavy tab switches", () => {
  const root = createRoot();
  let applied = false;
  let startViewTransitionCalled = false;
  const doc = {
    startViewTransition: (callback: () => void) => {
      startViewTransitionCalled = true;
      callback();
      return {
        finished: Promise.resolve(),
        skipTransition: () => {},
      };
    },
  };
  (root as { ownerDocument: typeof doc }).ownerDocument = doc;

  runThemeTransition(() => {
    applied = true;
  }, { root, mode: "instant" });

  assert.equal(applied, true);
  assert.equal(startViewTransitionCalled, false);
  assert.equal(root.getAttribute(THEME_TRANSITION_ATTR), null);
});
