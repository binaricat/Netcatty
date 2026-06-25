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
  "vault.host.notes.get": {
    hostId: { type: "string", description: "Vault host ID." },
  },
  "vault.host.notes.set": {
    hostId: { type: "string", description: "Vault host ID." },
    notes: { type: "string", description: "Host notes text." },
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
});

module.exports = {
  TOOL_INPUT_FIELDS,
  MODEL_DESCRIPTION_HINTS,
};
