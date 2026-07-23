"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_VISIBLE_FIELD_LENGTH,
  MAX_VISIBLE_RESOURCES,
  createNativePermissionDecisionProvider,
  describePermissionRequest,
  escapePermissionText,
} = require("./nativePermissionDecision.cjs");

function permissionRequest(overrides = {}) {
  return {
    requestId: "request-1",
    pluginId: "com.example.permissions",
    pluginName: "Permissions",
    publisher: "example",
    permission: "filesystem.read",
    resources: ["/allowed"],
    resourceKinds: ["directory"],
    reason: "Read project files",
    ...overrides,
  };
}

test("native permission decisions expose every host-owned grant scope", async () => {
  for (const { sessionId, response, expected } of [
    { response: 0, expected: { requestId: "request-1", decision: "deny" } },
    { response: 1, expected: { requestId: "request-1", decision: "allow", scope: "once" } },
    { sessionId: "session-1", response: 2, expected: {
      requestId: "request-1", decision: "allow", scope: "session",
    } },
    { response: 2, expected: {
      requestId: "request-1", decision: "allow", scope: "application",
    } },
    { response: 3, expected: {
      requestId: "request-1", decision: "allow", scope: "always",
    } },
  ]) {
    let captured;
    const signal = new AbortController().signal;
    const provider = createNativePermissionDecisionProvider({
      dialog: {
        async showMessageBox(_window, options) {
          captured = options;
          return { response };
        },
      },
      window: {},
    });
    assert.deepEqual(await provider(permissionRequest({ sessionId }), { signal }), expected);
    assert.equal(captured.signal, signal);
    assert.equal(captured.cancelId, 0);
    assert.match(captured.detail, /directory and descendants/u);
  }
});

test("native permission decisions fail closed on cancellation and abort", async () => {
  const provider = createNativePermissionDecisionProvider({
    dialog: { showMessageBox: async () => ({ response: 999 }) },
  });
  assert.deepEqual(await provider(permissionRequest()), {
    requestId: "request-1",
    decision: "deny",
  });
  const controller = new AbortController();
  controller.abort(new Error("runtime stopped"));
  await assert.rejects(provider(permissionRequest(), { signal: controller.signal }), /runtime stopped/);
});

test("terminal interceptor permission prompts omit the unsupported one-use choice", async () => {
  let captured;
  const provider = createNativePermissionDecisionProvider({
    dialog: {
      async showMessageBox(options) {
        captured = options;
        return { response: 1 };
      },
    },
  });
  assert.deepEqual(await provider(permissionRequest({
    sessionId: "session-1",
    operationId: `terminal.interceptor.input:com.example.${"x".repeat(170)}`,
    allowedScopes: ["session", "application", "always"],
  })), {
    requestId: "request-1",
    decision: "allow",
    scope: "session",
  });
  assert.deepEqual(captured.buttons, [
    "Deny",
    "Allow for Session",
    "Allow for Application",
    "Always Allow",
  ]);
});

test("native permission request details are bounded and preserve resource kinds", () => {
  const resources = Array.from({ length: MAX_VISIBLE_RESOURCES + 5 }, (_, index) => `/path/${index}`);
  const detail = describePermissionRequest(permissionRequest({
    resources,
    resourceKinds: resources.map(() => "exact"),
  }));
  assert.match(detail, /and 5 more/u);
  assert.doesNotMatch(detail, /\/path\/24/u);
});

test("native permission dialogs visibly escape control and bidi characters", async () => {
  let captured;
  const provider = createNativePermissionDecisionProvider({
    dialog: {
      async showMessageBox(options) {
        captured = options;
        return { response: 0 };
      },
    },
  });
  await provider(permissionRequest({
    pluginName: "Plugin\nPermission: vault.credentials",
    publisher: "publisher\u202e",
    reason: "Read this\r\nAlways Allow",
    resources: ["/safe\nPermission: runtime.advanced"],
    resourceKinds: ["exact"],
  }));
  assert.match(captured.message, /Plugin\\nPermission: vault\.credentials/u);
  assert.match(captured.detail, /publisher\\u202e/u);
  assert.match(captured.detail, /Read this\\r\\nAlways Allow/u);
  assert.match(captured.detail, /\/safe\\nPermission: runtime\.advanced/u);
  assert.equal(captured.detail.split("\n").filter((line) => line.startsWith("Permission:")).length, 1);
  assert.equal(escapePermissionText("x".repeat(MAX_VISIBLE_FIELD_LENGTH + 20)).length, MAX_VISIBLE_FIELD_LENGTH);
});
