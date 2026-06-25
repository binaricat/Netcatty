"use strict";

/** @typedef {'builtin' | 'public' | 'cli' | 'global' | 'catty' | 'globalAgent'} CapabilitySurface */
/** @typedef {'implemented' | 'planned'} CapabilityStatus */
/** @typedef {'observer' | 'confirm' | 'autonomous'} PermissionMode */
/** @typedef {'sidebar' | 'global'} AgentKind */

const CAPABILITY_SURFACES = Object.freeze({
  BUILTIN: "builtin",
  PUBLIC: "public",
  CLI: "cli",
  GLOBAL: "global",
  /** Renderer-local sidebar (Catty) harness tools (no MCP/CLI exposure). */
  CATTY: "catty",
  /** Renderer-local global agent tools (no MCP/CLI exposure). */
  GLOBAL_AGENT: "globalAgent",
});

/** Where in the app an agent runs — orthogonal to RPC/MCP/CLI capability surfaces. */
const AGENT_KINDS = Object.freeze({
  /** Chat side panel (Catty). */
  SIDEBAR: "sidebar",
  /** Future app-wide agent (cross-window / proactive). */
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
  AGENT_KINDS,
  CAPABILITY_SURFACES,
  CAPABILITY_STATUS,
  PERMISSION_MODES,
  RPC_TIMEOUT_DEFAULTS,
};
