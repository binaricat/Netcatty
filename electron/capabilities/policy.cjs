"use strict";

const {
  APPROVAL_DENIAL_MESSAGES,
  APPROVAL_DENIAL_REASONS,
  CAPABILITY_SURFACES,
  PERMISSION_MODES,
} = require("./constants.cjs");
const { getCapabilityByRpcMethod } = require("./registry.cjs");

const OBSERVER_DENY_MESSAGE = APPROVAL_DENIAL_MESSAGES.OBSERVER_DENIED;
const CHAT_SESSION_REQUIRED_MESSAGE = "chatSessionId is required for write operations.";
const CHAT_SESSION_CANCELLED_MESSAGE = "Operation cancelled: the SDK agent session was stopped.";
const USER_DENIED_MESSAGE = APPROVAL_DENIAL_MESSAGES.USER_DENIED;

function denied(reason, error, capability) {
  return {
    allowed: false,
    requiresApproval: false,
    error,
    denialReason: reason,
    capability,
  };
}

function requiresApprovalInConfirmMode(capability, surface) {
  if (!capability) return false;
  const binding = capability.surfaces?.[surface];
  if (binding?.confirmInConfirmMode === true) return true;
  if (capability.policy.bypassesApproval) return false;
  if (capability.policy.write) return true;
  if (capability.policy.sensitiveRead && binding?.confirmInConfirmMode !== false) {
    return binding?.confirmInConfirmMode === true;
  }
  return false;
}

function isBlockedInObserverMode(capability) {
  if (!capability) return false;
  if (capability.policy.bypassesObserverBlock) return false;
  return capability.policy.write;
}

function evaluateRpcPermission({
  rpcMethod,
  surface = CAPABILITY_SURFACES.BUILTIN,
  permissionMode = PERMISSION_MODES.CONFIRM,
  params = {},
  context = {},
}) {
  const capability = getCapabilityByRpcMethod(rpcMethod, surface);
  if (!capability) {
    return {
      allowed: true,
      requiresApproval: false,
      capability: null,
    };
  }

  if (capability?.policy.write && !params?.chatSessionId && surface === CAPABILITY_SURFACES.BUILTIN) {
    return denied(APPROVAL_DENIAL_REASONS.POLICY_DENIED, CHAT_SESSION_REQUIRED_MESSAGE, capability);
  }

  if (
    capability?.policy.write
    && !capability.policy.bypassesChatCancel
    && context.chatSessionCancelled
    && surface === CAPABILITY_SURFACES.BUILTIN
  ) {
    return denied(APPROVAL_DENIAL_REASONS.POLICY_DENIED, CHAT_SESSION_CANCELLED_MESSAGE, capability);
  }

  if (permissionMode === PERMISSION_MODES.OBSERVER && isBlockedInObserverMode(capability)) {
    return denied(APPROVAL_DENIAL_REASONS.OBSERVER_DENIED, OBSERVER_DENY_MESSAGE, capability);
  }

  const requiresApproval = permissionMode === PERMISSION_MODES.CONFIRM
    && requiresApprovalInConfirmMode(capability, surface);

  return {
    allowed: true,
    requiresApproval,
    capability,
  };
}

function buildRpcMethodSet(surface, predicate) {
  const { getRpcMethodsForSurface } = require("./registry.cjs");
  const methods = new Set();
  for (const rpcMethod of getRpcMethodsForSurface(surface)) {
    const capability = getCapabilityByRpcMethod(rpcMethod, surface);
    if (!capability || capability.status !== "implemented") continue;
    if (predicate(capability, rpcMethod)) {
      methods.add(rpcMethod);
    }
  }
  return methods;
}

const BUILTIN_WRITE_RPC_METHODS = buildRpcMethodSet(CAPABILITY_SURFACES.BUILTIN, (capability) => capability.policy.write);
const BUILTIN_APPROVAL_RPC_METHODS = buildRpcMethodSet(
  CAPABILITY_SURFACES.BUILTIN,
  (capability, rpcMethod) => requiresApprovalInConfirmMode(capability, CAPABILITY_SURFACES.BUILTIN),
);
const PUBLIC_WRITE_RPC_METHODS = buildRpcMethodSet(CAPABILITY_SURFACES.PUBLIC, (capability) => capability.policy.write);
const PUBLIC_CONFIRM_RPC_METHODS = buildRpcMethodSet(
  CAPABILITY_SURFACES.PUBLIC,
  (capability) => requiresApprovalInConfirmMode(capability, CAPABILITY_SURFACES.PUBLIC),
);

function isBuiltinWriteRpcMethod(method) {
  return BUILTIN_WRITE_RPC_METHODS.has(method);
}

function isBuiltinApprovalRpcMethod(method) {
  return BUILTIN_APPROVAL_RPC_METHODS.has(method);
}

function isPublicWriteRpcMethod(method) {
  return PUBLIC_WRITE_RPC_METHODS.has(method);
}

function isPublicConfirmRpcMethod(method) {
  return PUBLIC_CONFIRM_RPC_METHODS.has(method);
}

module.exports = {
  OBSERVER_DENY_MESSAGE,
  CHAT_SESSION_REQUIRED_MESSAGE,
  CHAT_SESSION_CANCELLED_MESSAGE,
  USER_DENIED_MESSAGE,
  APPROVAL_DENIAL_REASONS,
  requiresApprovalInConfirmMode,
  isBlockedInObserverMode,
  evaluateRpcPermission,
  BUILTIN_WRITE_RPC_METHODS,
  BUILTIN_APPROVAL_RPC_METHODS,
  PUBLIC_WRITE_RPC_METHODS,
  PUBLIC_CONFIRM_RPC_METHODS,
  isBuiltinWriteRpcMethod,
  isBuiltinApprovalRpcMethod,
  isPublicWriteRpcMethod,
  isPublicConfirmRpcMethod,
};
