import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldDeferExternalActionWhileAppLocked,
  shouldNotifyAppLockGateRendererReady,
  shouldRenderAppLockGateChildren,
} from "./AppLockGate.tsx";

test("shouldRenderAppLockGateChildren withholds startup-locked route children until unlock", () => {
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "startup",
      hasRenderedChildren: false,
    }),
    false,
  );
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: false,
      lockReason: null,
      hasRenderedChildren: false,
    }),
    true,
  );
});

test("shouldRenderAppLockGateChildren force-renders terminal popup children before init", () => {
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: false,
      locked: true,
      lockReason: "startup",
      hasRenderedChildren: false,
      forceRenderChildren: true,
    }),
    true,
  );
});

test("shouldRenderAppLockGateChildren withholds first mount for idle and background locks", () => {
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "idle",
      hasRenderedChildren: false,
    }),
    false,
  );
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "background",
      hasRenderedChildren: false,
    }),
    false,
  );
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "manual",
      hasRenderedChildren: false,
    }),
    false,
  );
});

test("shouldRenderAppLockGateChildren withholds children before runtime initialization", () => {
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: false,
      locked: false,
      lockReason: null,
      hasRenderedChildren: false,
    }),
    false,
  );
});

test("shouldRenderAppLockGateChildren keeps mounted children for manual and idle locks", () => {
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "manual",
      hasRenderedChildren: true,
    }),
    true,
  );
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "idle",
      hasRenderedChildren: true,
    }),
    true,
  );
});

test("shouldRenderAppLockGateChildren keeps existing children mounted for reopen locks", () => {
  assert.equal(
    shouldRenderAppLockGateChildren({
      initialized: true,
      locked: true,
      lockReason: "startup",
      hasRenderedChildren: true,
    }),
    true,
  );
});

test("shouldNotifyAppLockGateRendererReady waits until locked children can mount", () => {
  assert.equal(
    shouldNotifyAppLockGateRendererReady({
      notifyRendererReady: true,
      renderChildren: false,
    }),
    false,
  );
  assert.equal(
    shouldNotifyAppLockGateRendererReady({
      notifyRendererReady: true,
      renderChildren: true,
    }),
    true,
  );
  assert.equal(
    shouldNotifyAppLockGateRendererReady({
      notifyRendererReady: false,
      renderChildren: true,
    }),
    false,
  );
});

test("shouldDeferExternalActionWhileAppLocked queues actions only while locked", () => {
  assert.equal(shouldDeferExternalActionWhileAppLocked({ locked: true }), true);
  assert.equal(shouldDeferExternalActionWhileAppLocked({ locked: false }), false);
});
