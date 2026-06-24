"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

function sftpCapability(id, description, policyOverrides, surfaces) {
  return {
    id,
    domain: "sftp",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description,
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
      ...policyOverrides,
    },
    surfaces,
  };
}

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const SFTP_CAPABILITIES = [
  sftpCapability(
    "sftp.list",
    "List a remote directory over SFTP.",
    { sensitiveRead: true },
    {
      builtin: { rpcMethod: "netcatty/sftp/list" },
      public: { rpcMethod: "public/sftp/list", mcpTool: "sftp_list", confirmInConfirmMode: true },
      cli: { command: ["sftp", "list"] },
    },
  ),
  sftpCapability(
    "sftp.read",
    "Read a remote file over SFTP.",
    { sensitiveRead: true },
    {
      builtin: { rpcMethod: "netcatty/sftp/read" },
      public: { rpcMethod: "public/sftp/readFile", mcpTool: "sftp_read_file", confirmInConfirmMode: true },
      cli: { command: ["sftp", "read"] },
    },
  ),
  sftpCapability(
    "sftp.write",
    "Write a remote file over SFTP.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/write" },
      public: { rpcMethod: "public/sftp/writeFile", mcpTool: "sftp_write_file" },
      cli: { command: ["sftp", "write"] },
    },
  ),
  sftpCapability(
    "sftp.download",
    "Download a remote file to a local path.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/download" },
      cli: { command: ["sftp", "download"] },
    },
  ),
  sftpCapability(
    "sftp.upload",
    "Upload a local file to a remote path.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/upload" },
      cli: { command: ["sftp", "upload"] },
    },
  ),
  sftpCapability(
    "sftp.stat",
    "Get remote file metadata over SFTP.",
    { sensitiveRead: true },
    {
      builtin: { rpcMethod: "netcatty/sftp/stat" },
      public: { rpcMethod: "public/sftp/stat", mcpTool: "sftp_stat", confirmInConfirmMode: true },
      cli: { command: ["sftp", "stat"] },
    },
  ),
  sftpCapability(
    "sftp.home",
    "Get the remote home directory for a session.",
    { sensitiveRead: true },
    {
      builtin: { rpcMethod: "netcatty/sftp/home" },
      public: { rpcMethod: "public/sftp/home", mcpTool: "sftp_home", confirmInConfirmMode: true },
      cli: { command: ["sftp", "home"] },
    },
  ),
  sftpCapability(
    "sftp.mkdir",
    "Create a remote directory over SFTP.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/mkdir" },
      public: { rpcMethod: "public/sftp/mkdir", mcpTool: "sftp_mkdir" },
      cli: { command: ["sftp", "mkdir"] },
    },
  ),
  sftpCapability(
    "sftp.delete",
    "Delete a remote file or directory over SFTP.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/delete" },
      public: { rpcMethod: "public/sftp/delete", mcpTool: "sftp_delete" },
      cli: { command: ["sftp", "delete"] },
    },
  ),
  sftpCapability(
    "sftp.rename",
    "Rename a remote file or directory over SFTP.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/rename" },
      public: { rpcMethod: "public/sftp/rename", mcpTool: "sftp_rename" },
      cli: { command: ["sftp", "rename"] },
    },
  ),
  sftpCapability(
    "sftp.chmod",
    "Change remote file permissions over SFTP.",
    { write: true, bypassesApproval: false, bypassesChatCancel: false },
    {
      builtin: { rpcMethod: "netcatty/sftp/chmod" },
      public: { rpcMethod: "public/sftp/chmod", mcpTool: "sftp_chmod" },
      cli: { command: ["sftp", "chmod"] },
    },
  ),
];

module.exports = { SFTP_CAPABILITIES };
