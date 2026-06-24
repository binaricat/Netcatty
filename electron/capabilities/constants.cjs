"use strict";

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
  DEFAULT_APPROVAL_TIMEOUT_MS: 110_000,
});

module.exports = {
  CAPABILITY_SURFACES,
  CAPABILITY_STATUS,
  PERMISSION_MODES,
  RPC_TIMEOUT_DEFAULTS,
};
