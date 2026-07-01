"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRpcTimeoutMs, isLongRunningRpcMethod, isApprovalWaitRpcMethod } = require("./rpcTimeouts.cjs");
const { CAPABILITY_SURFACES, PERMISSION_MODES, RPC_TIMEOUT_DEFAULTS } = require("./constants.cjs");

test("long-running rpc methods include exec and sftp home", () => {
  assert.equal(isLongRunningRpcMethod("netcatty/exec"), true);
  assert.equal(isLongRunningRpcMethod("netcatty/sftp/read"), true);
  assert.equal(isLongRunningRpcMethod("netcatty/sftp/home"), true);
  assert.equal(isLongRunningRpcMethod("netcatty/jobPoll"), false);
});

test("approval wait methods follow confirm mode and capability policy", () => {
  assert.equal(
    isApprovalWaitRpcMethod("netcatty/exec", CAPABILITY_SURFACES.BUILTIN, PERMISSION_MODES.CONFIRM),
    true,
  );
  assert.equal(
    isApprovalWaitRpcMethod("netcatty/jobStop", CAPABILITY_SURFACES.BUILTIN, PERMISSION_MODES.CONFIRM),
    false,
  );
  assert.equal(
    isApprovalWaitRpcMethod("netcatty/sftp/list", CAPABILITY_SURFACES.BUILTIN, PERMISSION_MODES.CONFIRM),
    false,
  );
  assert.equal(
    isApprovalWaitRpcMethod("public/sftp/list", CAPABILITY_SURFACES.PUBLIC, PERMISSION_MODES.CONFIRM),
    true,
  );
});

test("resolveRpcTimeoutMs combines operation and approval budgets", () => {
  const timeoutMs = resolveRpcTimeoutMs("netcatty/exec", {
    surface: CAPABILITY_SURFACES.BUILTIN,
    bridgeCommandTimeoutMs: 60_000,
    bridgePermissionMode: PERMISSION_MODES.CONFIRM,
    bridgeApprovalTimeoutMs: 110_000,
  });
  assert.equal(
    timeoutMs,
    Math.max(
      RPC_TIMEOUT_DEFAULTS.DEFAULT_RPC_TIMEOUT_MS,
      110_000 + 60_000 + RPC_TIMEOUT_DEFAULTS.RPC_TIMEOUT_BUFFER_MS,
    ),
  );
});

test("resolveRpcTimeoutMs falls back to default for lightweight rpc", () => {
  const timeoutMs = resolveRpcTimeoutMs("netcatty/getStatus", {
    surface: CAPABILITY_SURFACES.BUILTIN,
    bridgePermissionMode: PERMISSION_MODES.CONFIRM,
  });
  assert.equal(timeoutMs, RPC_TIMEOUT_DEFAULTS.DEFAULT_RPC_TIMEOUT_MS);
});
