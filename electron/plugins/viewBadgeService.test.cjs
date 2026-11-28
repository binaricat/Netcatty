"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginViewBadgeService } = require("./viewBadgeService.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function makeContext(overrides = {}) {
  const pluginId = overrides.pluginId ?? "com.example.monitor";
  return {
    pluginId,
    pluginVersion: "1.0.0",
    runtimeId: overrides.runtimeId ?? "runtime-1",
    manifest: overrides.manifest ?? {
      id: pluginId,
      contributes: {
        views: [
          { id: `${pluginId}.workbench`, title: "Monitor", location: "vault-page" },
          { id: `${pluginId}.sidebar`, title: "Metrics", location: "terminal-sidebar" },
          { id: `${pluginId}.modal`, title: "Modal", location: "modal" },
        ],
      },
    },
  };
}

test("PluginViewBadgeService sets, clamps, deduplicates, prioritizes, and clears badges", () => {
  let now = 1_000;
  const events = [];
  const service = new PluginViewBadgeService({ clock: () => ++now });
  service.onDidChange((badges) => events.push(badges));

  const ctx = makeContext();

  // Numeric count + tone + tooltip
  service.setBadge({
    viewId: "com.example.monitor.workbench",
    count: 3,
    tone: "warning",
    tooltip: "3 active alerts",
  }, ctx);
  assert.equal(events.length, 1);
  assert.equal(service.listBadges().length, 1);
  assert.deepEqual(service.listBadges()[0], {
    pluginId: "com.example.monitor",
    viewId: "com.example.monitor.workbench",
    count: 3,
    tone: "warning",
    tooltip: "3 active alerts",
    updatedAt: 1_001,
  });

  // Duplicate badge is a no-op (no extra broadcast)
  service.setBadge({
    viewId: "com.example.monitor.workbench",
    count: 3,
    tone: "warning",
    tooltip: "3 active alerts",
  }, ctx);
  assert.equal(events.length, 1);

  // Count > 999 is clamped to 999
  service.setBadge({
    viewId: "com.example.monitor.workbench",
    count: 4200,
    tone: "danger",
  }, ctx);
  assert.equal(service.listBadges()[0].count, 999);
  assert.equal(service.listBadges()[0].tone, "danger");

  // Text badge on terminal-sidebar view
  service.setBadge({
    viewId: "com.example.monitor.sidebar",
    text: " NEW ",
    tone: "info",
  }, ctx);
  assert.equal(service.listBadges().length, 2);
  assert.equal(service.listBadges()[0].text, "NEW");
  assert.equal(service.listBadges()[0].tone, "info");

  // Dot badge when count is 0 and text is null
  service.setBadge({
    viewId: "com.example.monitor.workbench",
    count: 0,
    text: null,
    dot: true,
    tone: "default",
  }, ctx);
  const workbenchBadge = service.listBadges().find((b) => b.viewId === "com.example.monitor.workbench");
  assert.equal(workbenchBadge.dot, true);
  assert.equal(workbenchBadge.count, undefined);
  assert.equal(workbenchBadge.text, undefined);

  // Clear badge with count: null / dot: false
  service.setBadge({
    viewId: "com.example.monitor.workbench",
    count: null,
    text: null,
    dot: false,
  }, ctx);
  assert.equal(service.listBadges().length, 1);
  assert.equal(service.listBadges()[0].viewId, "com.example.monitor.sidebar");

  // Clear remaining badge with { viewId }
  service.setBadge({ viewId: "com.example.monitor.sidebar" }, ctx);
  assert.deepEqual(service.listBadges(), []);
  service.shutdown();
});

test("PluginViewBadgeService rejects foreign, unknown, unsupported-location, and malformed badges", () => {
  const service = new PluginViewBadgeService();
  const ctx = makeContext();

  // Foreign viewId
  assert.throws(
    () => service.setBadge({ viewId: "com.other.plugin.workbench", count: 1 }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  // Unknown viewId with own prefix
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.nonexistent", count: 1 }, ctx),
    (err) => err?.code === RPC_ERRORS.notFound,
  );
  // Non-sidebar/non-vault-page location (modal)
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.modal", count: 1 }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  // Negative count & non-integer count
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", count: -1 }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", count: 1.5 }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  // Text > 4 chars, control chars, non-ASCII
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", text: "HELLO" }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", text: "A\nB" }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", text: "\u4e2d\u6587" }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  // Invalid tone
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", count: 1, tone: "purple" }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  // Oversized tooltip or control char in tooltip
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", count: 1, tooltip: "x".repeat(161) }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", count: 1, tooltip: "bad\u0007bell" }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  // Unknown parameter key
  assert.throws(
    () => service.setBadge({ viewId: "com.example.monitor.workbench", count: 1, extra: true }, ctx),
    (err) => err?.code === RPC_ERRORS.invalidArgument,
  );
  assert.deepEqual(service.listBadges(), []);
  service.shutdown();
});

test("PluginViewBadgeService clears badges on runtime stop, plugin disable, crash, quarantine, and App Lock", () => {
  let onContributionChange;
  let onLockChange;
  let locked = false;
  const service = new PluginViewBadgeService({
    contributionService: {
      onDidChange(listener) {
        onContributionChange = listener;
        return { dispose() {} };
      },
    },
    isLocked: () => locked,
    subscribeLock(listener) {
      onLockChange = listener;
      return () => {};
    },
  });

  const ctxA = makeContext({ pluginId: "com.example.alpha", runtimeId: "run-a" });
  const ctxB = makeContext({ pluginId: "com.example.beta", runtimeId: "run-b" });

  // Runtime cleanup removes only that runtime's badges
  service.setBadge({ viewId: "com.example.alpha.workbench", count: 2 }, ctxA);
  service.setBadge({ viewId: "com.example.beta.workbench", count: 5 }, ctxB);
  assert.equal(service.listBadges().length, 2);

  service.releaseRuntime("run-a");
  assert.deepEqual(service.listBadges().map((b) => b.pluginId), ["com.example.beta"]);

  // Contribution lifecycle events clear that plugin's badges
  for (const reason of ["plugin-disabled", "runtime-stopped", "runtime-error", "runtime-quarantined"]) {
    service.setBadge({ viewId: "com.example.alpha.workbench", count: 1 }, ctxA);
    assert.equal(service.listBadges().length, 2);
    onContributionChange({ reason, pluginId: "com.example.alpha" });
    assert.deepEqual(service.listBadges().map((b) => b.pluginId), ["com.example.beta"]);
  }

  // App Lock clears ALL badges and blocks setting new badges while locked
  locked = true;
  onLockChange({ locked: true });
  assert.deepEqual(service.listBadges(), []);
  assert.throws(
    () => service.setBadge({ viewId: "com.example.beta.workbench", count: 4 }, ctxB),
    (err) => err?.code === RPC_ERRORS.failedPrecondition,
  );

  // Unlock allows setting badges again
  locked = false;
  onLockChange({ locked: false });
  service.setBadge({ viewId: "com.example.beta.workbench", count: 4 }, ctxB);
  assert.equal(service.listBadges().length, 1);
  service.shutdown();
});
