"use strict";

const { CAPABILITY_SURFACES, PERMISSION_MODES, RPC_TIMEOUT_DEFAULTS } = require("./constants.cjs");
const { getCapabilityByRpcMethod } = require("./registry.cjs");
const { requiresApprovalInConfirmMode } = require("./policy.cjs");

const {
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_OPERATION_TIMEOUT_MS,
  RPC_TIMEOUT_BUFFER_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} = RPC_TIMEOUT_DEFAULTS;

function isLongRunningRpcMethod(method, surface = CAPABILITY_SURFACES.BUILTIN) {
  const capability = getCapabilityByRpcMethod(method, surface);
  return Boolean(capability?.policy.longRunning);
}

function isApprovalWaitRpcMethod(method, surface, permissionMode) {
  if (permissionMode !== PERMISSION_MODES.CONFIRM) return false;
  const capability = getCapabilityByRpcMethod(method, surface);
  return requiresApprovalInConfirmMode(capability, surface);
}

function resolveRpcTimeoutMs(
  method,
  {
    surface = CAPABILITY_SURFACES.BUILTIN,
    bridgeCommandTimeoutMs = null,
    bridgePermissionMode = null,
    bridgeApprovalTimeoutMs = null,
    defaultOperationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    defaultApprovalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    defaultRpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    timeoutBufferMs = RPC_TIMEOUT_BUFFER_MS,
  } = {},
) {
  const operationTimeoutMs = isLongRunningRpcMethod(method, surface)
    ? (Number.isFinite(bridgeCommandTimeoutMs) && bridgeCommandTimeoutMs > 0
      ? bridgeCommandTimeoutMs
      : defaultOperationTimeoutMs)
    : 0;

  const approvalTimeoutMs = isApprovalWaitRpcMethod(method, surface, bridgePermissionMode)
    ? (Number.isFinite(bridgeApprovalTimeoutMs) && bridgeApprovalTimeoutMs > 0
      ? bridgeApprovalTimeoutMs
      : defaultApprovalTimeoutMs)
    : 0;

  if (operationTimeoutMs > 0 && approvalTimeoutMs > 0) {
    return Math.max(defaultRpcTimeoutMs, approvalTimeoutMs + operationTimeoutMs + timeoutBufferMs);
  }
  if (operationTimeoutMs > 0) {
    return Math.max(defaultRpcTimeoutMs, operationTimeoutMs + timeoutBufferMs);
  }
  if (approvalTimeoutMs > 0) {
    return Math.max(defaultRpcTimeoutMs, approvalTimeoutMs + timeoutBufferMs);
  }
  return defaultRpcTimeoutMs;
}

module.exports = {
  isLongRunningRpcMethod,
  isApprovalWaitRpcMethod,
  resolveRpcTimeoutMs,
  RPC_TIMEOUT_DEFAULTS,
};
