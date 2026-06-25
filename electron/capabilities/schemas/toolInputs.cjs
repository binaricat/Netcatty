"use strict";

/**
 * Input field definitions keyed by capability id.
 * Single source for MCP, Catty, and CLI tool schemas.
 */
const TOOL_INPUT_FIELDS = Object.freeze({
  "terminal.execute": {
    sessionId: { type: "string", description: "The terminal session ID to execute on." },
    command: { type: "string", description: "The shell command to execute in the target session." },
  },
  "terminal.start": {
    sessionId: { type: "string", description: "The terminal session ID to start a long-running command on." },
    command: { type: "string", description: "The command to start in the target session." },
  },
  "terminal.poll": {
    jobId: { type: "string", description: "The background job ID returned by terminal_start." },
    offset: { type: "number", optional: true, description: "Character offset from a previous poll (default 0)." },
  },
  "terminal.stop": {
    jobId: { type: "string", description: "The background job ID returned by terminal_start." },
  },
  "session.environment": {},
  "attachment.list": {},
  "attachment.read": {
    filePath: { type: "string", optional: true, description: "Exact local attachment path." },
    filename: { type: "string", optional: true, description: "Attachment filename from list_attachments." },
  },
  "sftp.list": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote directory path." },
  },
  "sftp.read": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote file path to read." },
  },
  "sftp.stat": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote path to stat." },
  },
  "sftp.home": {
    sessionId: { type: "string", description: "SFTP session ID." },
  },
  "sftp.write": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote file path to write." },
    content: { type: "string", description: "File content to write." },
  },
  "sftp.download": {
    sessionId: { type: "string", description: "SFTP session ID." },
    remotePath: { type: "string", description: "Remote file path to download." },
    localPath: { type: "string", description: "Local destination path." },
  },
  "sftp.upload": {
    sessionId: { type: "string", description: "SFTP session ID." },
    localPath: { type: "string", description: "Local file path to upload." },
    remotePath: { type: "string", description: "Remote destination path." },
  },
  "sftp.mkdir": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote directory path to create." },
  },
  "sftp.delete": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote file or directory path to delete." },
  },
  "sftp.rename": {
    sessionId: { type: "string", description: "SFTP session ID." },
    oldPath: { type: "string", description: "Current remote path." },
    newPath: { type: "string", description: "New remote path." },
  },
  "sftp.chmod": {
    sessionId: { type: "string", description: "SFTP session ID." },
    path: { type: "string", description: "Remote file path." },
    mode: { type: "string", description: "Octal permission mode (e.g. 755)." },
  },
  "vault.host.get": {
    hostId: { type: "string", description: "Vault host ID." },
  },
  "vault.host.list": {},
  "vault.hosts.create": {
    hosts: {
      type: "string",
      description:
        "JSON array of host objects you extracted from the user's text. Each object: hostname (required), label, port, username, password, group, tags (array or comma-separated string), notes (Host Details remarks — NOT Vault sidebar Notes), protocol (ssh|telnet|local).",
    },
    dryRun: {
      type: "string",
      optional: true,
      description: "Set to true to validate and preview without writing to the vault.",
    },
    skipDuplicates: {
      type: "string",
      optional: true,
      description: "Set to false to create even when a matching host already exists (default true).",
    },
  },
  "vault.host.import": {
    format: {
      type: "string",
      description: "Import format: csv, putty, mobaxterm, securecrt, ssh_config, or auto to detect from text.",
    },
    text: { type: "string", description: "Exported host data text to import." },
    dryRun: {
      type: "string",
      optional: true,
      description: "Set to true to parse and preview without writing to the vault.",
    },
    skipDuplicates: {
      type: "string",
      optional: true,
      description: "Set to false to import even when a matching host already exists (default true).",
    },
    fileName: {
      type: "string",
      optional: true,
      description: "Optional source file name (helps SecureCRT .ini parsing).",
    },
  },
  "vault.host.notes.get": {
    hostId: { type: "string", description: "Vault host ID." },
  },
  "vault.host.notes.set": {
    hostId: { type: "string", description: "Vault host ID." },
    notes: { type: "string", description: "Host metadata notes (Host Details — not Vault sidebar Notes)." },
  },
  "vault.note.list": {},
  "vault.note.get": {
    noteId: { type: "string", description: "Vault note ID from vault_notes_list." },
  },
  "vault.note.create": {
    title: { type: "string", description: "Note title shown in Vault → Notes." },
    content: { type: "string", description: "Markdown note body." },
    group: { type: "string", optional: true, description: "Optional folder path (e.g. infra/prod)." },
    linkedHostIds: { type: "string", optional: true, description: "Optional JSON array of vault host IDs to link." },
    tags: { type: "string", optional: true, description: "Optional JSON array of tag strings." },
  },
  "vault.note.update": {
    noteId: { type: "string", description: "Vault note ID to update." },
    title: { type: "string", optional: true, description: "New title." },
    content: { type: "string", optional: true, description: "New markdown body." },
    group: { type: "string", optional: true, description: "New folder path." },
    linkedHostIds: { type: "string", optional: true, description: "Optional JSON array of vault host IDs to link." },
    tags: { type: "string", optional: true, description: "Optional JSON array of tag strings." },
  },
  "vault.snippets.list": {},
  "vault.snippets.get": {
    snippetId: { type: "string", description: "Snippet ID." },
  },
  "vault.snippets.run": {
    snippetId: { type: "string", description: "Snippet ID to run." },
    sessionId: { type: "string", description: "Terminal session ID to execute on." },
    variables: { type: "string", optional: true, description: "JSON object of snippet variable values." },
  },
  "portforward.rules.list": {},
  "portforward.tunnels.list": {},
  "portforward.start": {
    ruleId: { type: "string", description: "Port forwarding rule ID." },
  },
  "portforward.stop": {
    ruleId: { type: "string", description: "Port forwarding rule ID." },
  },
  "harness.tool_output.read": {
    handleId: { type: "string", description: "Tool output handle id from a prior truncated result." },
    mode: { type: "string", optional: true, description: "Which portion to read: head, tail, or full." },
    maxChars: { type: "number", optional: true, description: "Maximum characters to return." },
  },
  "harness.workspace.get_info": {},
  "harness.workspace.get_session_info": {
    sessionId: { type: "string", description: "The session ID to get information about." },
  },
  "harness.web.search": {
    query: { type: "string", description: "The search query to look up on the web." },
    maxResults: { type: "number", optional: true, description: "Maximum number of search results to return." },
  },
  "harness.url.fetch": {
    url: { type: "string", description: "The HTTPS URL to fetch." },
    maxLength: { type: "number", optional: true, description: "Maximum characters to return (default 50000)." },
  },
});

/** Long-form model guidance appended to terminal tool descriptions from catalog. */
const MODEL_DESCRIPTION_HINTS = Object.freeze({
  "terminal.execute":
    "Use only for commands expected to finish within about 60 seconds. For long-running commands use terminal_start and terminal_poll.",
  "terminal.start":
    "Prefer for builds, scans, log-following, or anything likely to exceed about 2 minutes.",
  "terminal.poll":
    "Wait at least about 30 seconds between polls unless output justifies checking sooner.",
  "vault.host.notes.get":
    "Host metadata notes on a saved host — not Vault → Notes sidebar entries.",
  "vault.host.notes.set":
    "Host metadata notes on a saved host — not Vault → Notes sidebar entries. Prefer vault_notes_create/update when the user wants vault notes they can open in the Notes sidebar.",
  "vault.host.import":
    "Only for text in known export formats (PuTTY reg, MobaXterm ini, CSV template, SecureCRT, ssh_config). For arbitrary unstructured host lists from the user, extract fields yourself and call vault_hosts_create.",
  "vault.hosts.create":
    "Use when the user wants to add/create a host in Vault → Hosts (创建主机、SSH 连接凭据). NOT for Vault → Notes sidebar docs. Put SSH password in password field; long remarks/admin tables in host notes field. Never fall back to vault_notes_create if this fails.",
  "vault.note.create":
    "Use ONLY when the user wants markdown documentation in Vault → Notes sidebar (保险箱笔记). Do NOT use when the user asked to create/add a host — use vault_hosts_create instead.",
  "vault.note.update":
    "Update an existing Vault → Notes entry (visible in the vault notes sidebar).",
});

module.exports = {
  TOOL_INPUT_FIELDS,
  MODEL_DESCRIPTION_HINTS,
};
