"use strict";

/** Shared approval timeout constants for main-process bridges. */
const CATTY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_APPROVAL_TIMEOUT_MS = 110 * 1000;

module.exports = {
  CATTY_APPROVAL_TIMEOUT_MS,
  MCP_APPROVAL_TIMEOUT_MS,
};
