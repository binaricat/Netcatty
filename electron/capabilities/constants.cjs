"use strict";

const approvalPolicy = require("../../lib/aiApprovalPolicy.json");

/** @typedef {'builtin' | 'public' | 'cli' | 'global'} CapabilitySurface */
/** @typedef {'implemented' | 'planned'} CapabilityStatus */
/** @typedef {'observer' | 'confirm' | 'autonomous'} PermissionMode */

const CAPABILITY_SURFACES = Object.freeze({
  BUILTIN: "builtin",
  PUBLIC: "public",
  CLI: "cli",
  GLOBAL: "global",
});

const CAPABILITY_STATUS = Object.freeze({
  IMPLEMENTED: "implemented",
  PLANNED: "planned",
});

const PERMISSION_MODES = Object.freeze({
  OBSERVER: "observer",
  CONFIRM: "confirm",
  AUTONOMOUS: "autonomous",
});

const RPC_TIMEOUT_DEFAULTS = Object.freeze({
  DEFAULT_RPC_TIMEOUT_MS: 30_000,
  DEFAULT_OPERATION_TIMEOUT_MS: 60_000,
  RPC_TIMEOUT_BUFFER_MS: 5_000,
  DEFAULT_APPROVAL_TIMEOUT_MS: approvalPolicy.approvalTimeoutMs,
});

const APPROVAL_DENIAL_REASONS = Object.freeze({
  USER_DENIED: approvalPolicy.denialReasons.userDenied,
  TIMEOUT_AUTO_DENIED: approvalPolicy.denialReasons.timeoutAutoDenied,
  POLICY_DENIED: approvalPolicy.denialReasons.policyDenied,
  OBSERVER_DENIED: approvalPolicy.denialReasons.observerDenied,
});

const APPROVAL_DENIAL_MESSAGES = Object.freeze({
  USER_DENIED: approvalPolicy.messages[APPROVAL_DENIAL_REASONS.USER_DENIED],
  TIMEOUT_AUTO_DENIED: approvalPolicy.messages[APPROVAL_DENIAL_REASONS.TIMEOUT_AUTO_DENIED],
  POLICY_DENIED: approvalPolicy.messages[APPROVAL_DENIAL_REASONS.POLICY_DENIED],
  OBSERVER_DENIED: approvalPolicy.messages[APPROVAL_DENIAL_REASONS.OBSERVER_DENIED],
});

module.exports = {
  CAPABILITY_SURFACES,
  CAPABILITY_STATUS,
  PERMISSION_MODES,
  RPC_TIMEOUT_DEFAULTS,
  APPROVAL_DENIAL_REASONS,
  APPROVAL_DENIAL_MESSAGES,
};
