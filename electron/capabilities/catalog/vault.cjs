"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const VAULT_CAPABILITIES = [
  {
    id: "vault.host.get",
    domain: "vault",
    status: CAPABILITY_STATUS.PLANNED,
    description: "Get host metadata from the vault.",
    policy: {
      write: false,
      sensitiveRead: true,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      cli: { command: ["vault", "host", "get"] },
      global: { rpcMethod: "vault/host/get" },
    },
  },
  {
    id: "vault.host.notes.get",
    domain: "vault",
    status: CAPABILITY_STATUS.PLANNED,
    description: "Read host notes from the vault.",
    policy: {
      write: false,
      sensitiveRead: true,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      cli: { command: ["vault", "host-notes", "get"] },
      global: { rpcMethod: "vault/host/notes/get" },
      public: { rpcMethod: "public/vault/hostNotes/get", mcpTool: "host_notes_get" },
    },
  },
  {
    id: "vault.host.notes.set",
    domain: "vault",
    status: CAPABILITY_STATUS.PLANNED,
    description: "Update host notes in the vault.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      cli: { command: ["vault", "host-notes", "set"] },
      global: { rpcMethod: "vault/host/notes/set" },
    },
  },
  {
    id: "vault.snippets.list",
    domain: "vault",
    status: CAPABILITY_STATUS.PLANNED,
    description: "List code snippets stored in the vault.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      cli: { command: ["snippets", "list"] },
      global: { rpcMethod: "vault/snippets/list" },
      public: { rpcMethod: "public/vault/snippets/list", mcpTool: "snippets_list" },
    },
  },
  {
    id: "vault.snippets.get",
    domain: "vault",
    status: CAPABILITY_STATUS.PLANNED,
    description: "Get a single code snippet from the vault.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      cli: { command: ["snippets", "get"] },
      global: { rpcMethod: "vault/snippets/get" },
      public: { rpcMethod: "public/vault/snippets/get", mcpTool: "snippets_get" },
    },
  },
  {
    id: "vault.snippets.run",
    domain: "vault",
    status: CAPABILITY_STATUS.PLANNED,
    description: "Resolve snippet variables and execute a snippet in a terminal session.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      cli: { command: ["snippets", "run"] },
      global: { rpcMethod: "vault/snippets/run" },
      public: { rpcMethod: "public/vault/snippets/run", mcpTool: "snippets_run" },
    },
  },
];

module.exports = { VAULT_CAPABILITIES };
