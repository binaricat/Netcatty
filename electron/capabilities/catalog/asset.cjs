"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

const READ_POLICY = Object.freeze({
  write: false,
  sensitiveRead: true,
  longRunning: false,
  requiresChatSession: false,
  bypassesObserverBlock: false,
  bypassesApproval: true,
  bypassesChatCancel: true,
});

const WRITE_POLICY = Object.freeze({
  write: true,
  sensitiveRead: false,
  longRunning: false,
  requiresChatSession: false,
  bypassesObserverBlock: false,
  bypassesApproval: false,
  bypassesChatCancel: false,
});

function assetCapability(id, description, policy, rpcPath, mcpTool) {
  return {
    id,
    domain: "asset",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description,
    policy,
    surfaces: {
      global: { rpcMethod: rpcPath },
      public: { rpcMethod: `public/${rpcPath}`, mcpTool },
    },
  };
}

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const ASSET_CAPABILITIES = [
  assetCapability(
    "asset.list",
    "List saved server assets from Vault Hosts (metadata only; no passwords or keys).",
    READ_POLICY,
    "asset/list",
    "asset_list",
  ),
  assetCapability(
    "asset.get",
    "Get a saved server asset by host ID (metadata only; no passwords or keys).",
    READ_POLICY,
    "asset/get",
    "asset_get",
  ),
  assetCapability(
    "asset.add",
    "Add one or more saved server assets to Vault Hosts.",
    WRITE_POLICY,
    "asset/add",
    "asset_add",
  ),
  assetCapability(
    "asset.edit",
    "Edit fields on a saved server asset.",
    WRITE_POLICY,
    "asset/edit",
    "asset_edit",
  ),
  assetCapability(
    "asset.remove",
    "Remove a saved server asset from Vault Hosts.",
    WRITE_POLICY,
    "asset/remove",
    "asset_remove",
  ),
  assetCapability(
    "asset.open",
    "Open a saved server asset in the Vault Hosts UI.",
    WRITE_POLICY,
    "asset/open",
    "asset_open",
  ),
  assetCapability(
    "asset.connect",
    "Open a new SSH terminal session for a saved server asset.",
    WRITE_POLICY,
    "asset/connect",
    "asset_connect",
  ),
  assetCapability(
    "asset.disconnect",
    "Close an existing terminal session for a saved server asset.",
    WRITE_POLICY,
    "asset/disconnect",
    "asset_disconnect",
  ),
  assetCapability(
    "asset.reconnect",
    "Close and reopen an existing SSH terminal session for a saved server asset.",
    WRITE_POLICY,
    "asset/reconnect",
    "asset_reconnect",
  ),
];

module.exports = { ASSET_CAPABILITIES };
