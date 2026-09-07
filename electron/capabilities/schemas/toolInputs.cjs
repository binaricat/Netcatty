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
  "session.close": {
    sessionId: { type: "string", description: "The session ID returned by host_open." },
  },
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
  "vault.host.open": {
    hostId: { type: "string", description: "Vault host ID to open. Use vault_hosts_list / host_get to resolve id from label or hostname." },
  },
  "vault.hosts.create": {
    hosts: {
      type: "string",
      description:
        "JSON array of host objects you extracted from the user's text. Each object: hostname (required; host/ip aliases accepted), label (name alias accepted), port, username, password, keyPath or keypath (local private-key file path), passphrase (saved passphrase for that key path), group, tags (array or comma-separated string), notes (Host Details remarks — NOT Vault sidebar Notes), protocol (ssh|telnet|local), os (linux|windows|macos).",
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
  "vault.host.update": {
    hostId: { type: "string", description: "Vault host ID from vault_hosts_list." },
    label: { type: "string", optional: true, description: "New display name." },
    name: { type: "string", optional: true, description: "Alias for label." },
    hostname: { type: "string", optional: true, description: "New hostname or IP address." },
    host: { type: "string", optional: true, description: "Alias for hostname." },
    ip: { type: "string", optional: true, description: "Alias for hostname." },
    port: { type: "number", optional: true, description: "New connection port (1-65535)." },
    username: { type: "string", optional: true, description: "New login username. Clears any reusable identity binding so this value takes effect." },
    password: { type: "string", optional: true, description: "New password without changing key-based login. Password identities are detached so the new value takes effect. Empty string clears it and blocks inherited saved passwords. Pair with keyPath set to an empty string to switch from key login to password login." },
    savePassword: { type: "string", optional: true, description: "Set to true or false to enable or disable saved passwords. Pass true when setting a new password after clearing one." },
    keyPath: { type: "string", optional: true, description: "Local private-key file path. Empty string clears and blocks an inherited path." },
    keypath: { type: "string", optional: true, description: "Alias for keyPath." },
    passphrase: { type: "string", optional: true, description: "Saved passphrase for the host's local private-key path. Empty string clears the saved passphrase." },
    group: { type: "string", optional: true, description: "New group path. Empty string moves the host to the root." },
    tags: { type: "string", optional: true, description: "JSON array or comma-separated tag names. Empty string clears tags." },
    notes: { type: "string", optional: true, description: "Host Details remarks. Empty string clears notes." },
    protocol: { type: "string", optional: true, description: "New protocol: ssh, telnet, local, or serial." },
    os: { type: "string", optional: true, description: "Host operating system: linux, windows, or macos. Drives AI environment reporting and shell-aware behavior." },
    identityId: { type: "string", optional: true, description: "Reusable identity ID from vault_identities_list. Empty string detaches the identity." },
    jumpHostIds: { type: "string", optional: true, description: "JSON array of vault host IDs in jump order. Empty array clears the chain." },
    proxyProfileId: { type: "string", optional: true, description: "Reusable proxy ID from vault_proxy_profiles_list. Empty string clears it." },
    startupCommand: { type: "string", optional: true, description: "Command to run after connecting. Empty string clears it." },
    startupCommandRunMode: { type: "string", optional: true, description: "paste or lineDelay." },
    environmentVariables: { type: "string", optional: true, description: "JSON object or array of {name,value} entries. Empty object clears them." },
    moshEnabled: { type: "string", optional: true, description: "true or false." },
    moshServerPath: { type: "string", optional: true, description: "Optional mosh-server path." },
    etEnabled: { type: "string", optional: true, description: "true or false." },
    etPort: { type: "number", optional: true, description: "Eternal Terminal server port." },
    serialConfig: { type: "string", optional: true, description: "JSON object for serial connections: path, baudRate, and optional dataBits, stopBits, parity, flowControl, localEcho, lineMode, backspaceBehavior (default or ctrl-h). Existing backspaceBehavior is preserved when omitted." },
  },
  "vault.host.delete": {
    hostId: { type: "string", description: "Vault host ID from vault_hosts_list." },
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
    offset: { type: "number", optional: true, description: "Zero-based UTF-16 offset; default 0. Continue with returned nextOffset." },
    maxChars: { type: "number", optional: true, description: "Maximum excerpt length in UTF-16 units, at least 2; default and hard cap 6000." },
    query: { type: "string", optional: true, description: "Optional case-sensitive literal search, 1-200 UTF-16 units. Returns an excerpt starting at the next match at/after offset; matchOffset=null means no match. Keep query when continuing search." },
    expectedUpdatedAt: { type: "number", optional: true, description: "Pass note.updatedAt from the first read on subsequent reads to detect changes; restart if it changed." },
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
  "vault.note.delete": {
    noteId: { type: "string", description: "Vault note ID to delete." },
  },
  "vault.identity.list": {},
  "vault.proxyProfile.list": {},
  "vault.group.list": {},
  "vault.group.create": {
    path: { type: "string", description: "New group path, for example prod/web." },
    defaults: { type: "string", optional: true, description: "JSON object of group defaults: username, identityId, proxyProfileId, jumpHostIds, startupCommand, environmentVariables, moshEnabled, moshServerPath, etEnabled, etPort." },
  },
  "vault.group.update": {
    path: { type: "string", description: "Existing group path." },
    newPath: { type: "string", optional: true, description: "Optional replacement path to rename or move the group and descendants." },
    defaults: { type: "string", optional: true, description: "JSON object containing only group defaults to change." },
  },
  "vault.group.delete": {
    path: { type: "string", description: "Group path to delete, including descendants." },
    deleteHosts: { type: "string", optional: true, description: "Set true to delete hosts in the group; default moves them to the root." },
  },
  "vault.snippets.list": {},
  "vault.snippets.get": {
    snippetId: { type: "string", description: "Snippet ID." },
  },
  "vault.snippets.run": {
    snippetId: { type: "string", description: "Snippet ID to run." },
    sessionId: { type: "string", description: "Terminal session ID to execute on." },
    variables: { type: "string", optional: true, description: "JSON object of snippet variable values." },
    wait: { type: "string", optional: true, description: "Set to true to wait for script completion when kind=script." },
  },
  "vault.snippets.create": {
    label: { type: "string", description: "Snippet or script label." },
    content: { type: "string", description: "Snippet command text or script JavaScript source." },
    kind: { type: "string", optional: true, description: "snippet (default) or script for nct automation." },
    tags: { type: "string", optional: true, description: "Optional JSON array of tag strings." },
    targets: { type: "string", optional: true, description: "Optional JSON array of vault host IDs." },
    targetGroups: { type: "string", optional: true, description: "Optional JSON array of dynamic vault group paths." },
    targetsAllHosts: { type: "string", optional: true, description: "Set true to target all connectable hosts." },
    package: { type: "string", optional: true, description: "Optional vault package path." },
    shortkey: { type: "string", optional: true, description: "Optional keyboard shortcut." },
    noAutoRun: { type: "string", optional: true, description: "For text snippets: paste without pressing Enter." },
    multiLineRunMode: { type: "string", optional: true, description: "For multi-line text snippets: paste (default) or lineDelay." },
    language: { type: "string", optional: true, description: "javascript or python (UI label only; runtime is JS)." },
    description: { type: "string", optional: true, description: "Optional script description." },
    trigger: { type: "string", optional: true, description: "manual, onConnect, or onOutput (scripts)." },
    triggerPattern: { type: "string", optional: true, description: "Regex when trigger=onOutput." },
  },
  "vault.snippets.update": {
    snippetId: { type: "string", description: "Snippet ID to update." },
    label: { type: "string", optional: true, description: "New label." },
    content: { type: "string", optional: true, description: "New command or script source." },
    kind: { type: "string", optional: true, description: "snippet or script." },
    tags: { type: "string", optional: true, description: "Optional JSON array of tag strings." },
    targets: { type: "string", optional: true, description: "Optional JSON array of vault host IDs." },
    targetGroups: { type: "string", optional: true, description: "Optional JSON array of dynamic vault group paths." },
    targetsAllHosts: { type: "string", optional: true, description: "Set true to target all connectable hosts." },
    package: { type: "string", optional: true, description: "Optional vault package path." },
    shortkey: { type: "string", optional: true, description: "Optional keyboard shortcut." },
    noAutoRun: { type: "string", optional: true, description: "For text snippets: paste without pressing Enter." },
    multiLineRunMode: { type: "string", optional: true, description: "For multi-line text snippets: paste (default) or lineDelay." },
    language: { type: "string", optional: true, description: "javascript or python." },
    description: { type: "string", optional: true, description: "Optional script description." },
    trigger: { type: "string", optional: true, description: "manual, onConnect, or onOutput." },
    triggerPattern: { type: "string", optional: true, description: "Regex when trigger=onOutput." },
  },
  "vault.snippets.delete": {
    snippetId: { type: "string", description: "Snippet ID to delete." },
  },
  "vault.scripts.list": {},
  "vault.scripts.get": {
    scriptId: { type: "string", description: "Automation script ID." },
  },
  "vault.scripts.create": {
    label: { type: "string", description: "Script label." },
    content: { type: "string", description: "JavaScript automation source using nct.* API." },
    tags: { type: "string", optional: true, description: "Optional JSON array of tag strings." },
    targets: { type: "string", optional: true, description: "Optional JSON array of vault host IDs." },
    targetGroups: { type: "string", optional: true, description: "Optional JSON array of dynamic vault group paths." },
    targetsAllHosts: { type: "string", optional: true, description: "Set true to target all connectable hosts." },
    package: { type: "string", optional: true, description: "Optional vault package path." },
    description: { type: "string", optional: true, description: "Optional script description." },
    trigger: { type: "string", optional: true, description: "manual (default), onConnect, or onOutput." },
    triggerPattern: { type: "string", optional: true, description: "Regex when trigger=onOutput." },
  },
  "vault.scripts.update": {
    scriptId: { type: "string", description: "Script ID to update." },
    label: { type: "string", optional: true, description: "New label." },
    content: { type: "string", optional: true, description: "New JavaScript source." },
    tags: { type: "string", optional: true, description: "Optional JSON array of tag strings." },
    targets: { type: "string", optional: true, description: "Optional JSON array of vault host IDs." },
    targetGroups: { type: "string", optional: true, description: "Optional JSON array of dynamic vault group paths." },
    targetsAllHosts: { type: "string", optional: true, description: "Set true to target all connectable hosts." },
    package: { type: "string", optional: true, description: "Optional vault package path." },
    description: { type: "string", optional: true, description: "Optional script description." },
    trigger: { type: "string", optional: true, description: "manual, onConnect, or onOutput." },
    triggerPattern: { type: "string", optional: true, description: "Regex when trigger=onOutput." },
  },
  "vault.scripts.delete": {
    scriptId: { type: "string", description: "Script ID to delete." },
  },
  "vault.scripts.run": {
    scriptId: { type: "string", description: "Script ID to run." },
    sessionId: { type: "string", description: "Terminal session ID." },
    wait: { type: "string", optional: true, description: "Set to true to block until the script completes." },
  },
  "vault.scripts.reference": {},
  "vault.scripts.runs.list": {
    sessionId: { type: "string", optional: true, description: "Optional terminal session ID filter." },
  },
  "vault.scripts.run.stop": {
    runId: { type: "string", description: "Script run ID from scripts_run or scripts_runs_list." },
  },
  "vault.scripts.run.pause": {
    runId: { type: "string", description: "Script run ID to pause." },
  },
  "vault.scripts.run.resume": {
    runId: { type: "string", description: "Script run ID to resume." },
  },
  "vault.scripts.targets.set": {
    scriptId: { type: "string", description: "Script ID." },
    targets: { type: "string", optional: true, description: "JSON array of vault host IDs (omit when targetsAllHosts=true)." },
    targetGroups: { type: "string", optional: true, description: "JSON array of dynamic vault group paths (omit when targetsAllHosts=true)." },
    targetsAllHosts: { type: "string", optional: true, description: "Set true to target all connectable hosts." },
  },
  "vault.host.connectScripts.list": {
    hostId: { type: "string", description: "Vault host ID." },
  },
  "vault.host.connectScripts.set": {
    hostId: { type: "string", description: "Vault host ID." },
    scriptIds: { type: "string", description: "JSON array of onConnect script IDs in run order." },
  },
  "portforward.rules.list": {},
  "portforward.rules.create": {
    label: { type: "string", optional: true, description: "Rule label." },
    type: { type: "string", description: "local, remote, or dynamic." },
    localPort: { type: "number", description: "Local listening port (1-65535)." },
    bindAddress: { type: "string", optional: true, description: "Bind address; default 127.0.0.1." },
    remoteHost: { type: "string", optional: true, description: "Required except for dynamic forwarding." },
    remotePort: { type: "number", optional: true, description: "Required except for dynamic forwarding." },
    hostId: { type: "string", description: "Vault host ID used for the tunnel." },
    autoStart: { type: "string", optional: true, description: "true or false." },
  },
  "portforward.rules.update": {
    ruleId: { type: "string", description: "Port forwarding rule ID." },
    label: { type: "string", optional: true, description: "New rule label." },
    type: { type: "string", optional: true, description: "local, remote, or dynamic." },
    localPort: { type: "number", optional: true, description: "Local listening port." },
    bindAddress: { type: "string", optional: true, description: "Bind address." },
    remoteHost: { type: "string", optional: true, description: "Remote host." },
    remotePort: { type: "number", optional: true, description: "Remote port." },
    hostId: { type: "string", optional: true, description: "Vault host ID used for the tunnel." },
    autoStart: { type: "string", optional: true, description: "true or false." },
  },
  "portforward.rules.duplicate": {
    ruleId: { type: "string", description: "Port forwarding rule ID to copy." },
  },
  "portforward.rules.delete": {
    ruleId: { type: "string", description: "Port forwarding rule ID to delete." },
  },
  "portforward.tunnels.list": {},
  "portforward.start": {
    ruleId: { type: "string", description: "Port forwarding rule ID." },
  },
  "portforward.stop": {
    ruleId: { type: "string", description: "Port forwarding rule ID." },
  },
  "harness.tool_output.read": {
    handleId: { type: "string", description: "Tool output handle id from a prior truncated result." },
    mode: { type: "string", optional: true, description: "Which portion to read: head, tail, range, search, or bounded full." },
    maxChars: { type: "number", optional: true, description: "Requested characters to return. The service enforces a hard upper bound." },
    offset: { type: "number", optional: true, description: "Zero-based character offset for range reads or search continuation." },
    query: { type: "string", optional: true, description: "Case-insensitive search text when mode is search." },
  },
  "harness.workspace.get_info": {},
  "harness.workspace.get_session_info": {
    sessionId: { type: "string", description: "The session ID to get information about." },
  },
  "harness.terminal.read_context": {
    sessionId: { type: "string", optional: true, description: "Terminal session ID. Required when the current AI scope contains more than one terminal." },
    range: { type: "string", optional: true, description: "Which terminal slice to read: viewport, tail, head, or lines. Defaults to viewport." },
    startLine: { type: "number", optional: true, description: "Zero-based terminal buffer line to start from when range is lines." },
    maxLines: { type: "number", optional: true, description: "Maximum terminal rows to return. Defaults to 80, capped at 300." },
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
    "Use only for commands expected to finish within about 60 seconds. For long-running commands use terminal_start and terminal_poll. Commands run in an isolated subshell of the visible terminal: the user sees the output live, but shell state such as cd, export, or set does not persist between calls — use absolute paths or combine cd with the command (cd /path && cmd).",
  "terminal.start":
    "Prefer for builds, scans, log-following, or anything likely to exceed about 2 minutes. Shell state such as cd or export does not persist between calls — combine cd with the command.",
  "terminal.poll":
    "Wait at least about 30 seconds between polls unless output justifies checking sooner.",
  "vault.host.notes.get":
    "Host metadata notes on a saved host — not Vault → Notes sidebar entries.",
  "vault.host.notes.set":
    "Host metadata notes on a saved host — not Vault → Notes sidebar entries. Prefer vault_notes_create/update when the user wants vault notes they can open in the Notes sidebar.",
  "vault.host.open":
    "Opens a terminal tab for a saved vault host (same as clicking the host in Netcatty). Connection may still be establishing when the tool returns — use get_environment or wait briefly before terminal_execute if needed. Call session_close with the returned sessionId when the task is finished. Auth prompts (passphrase / keyboard-interactive) still require the user in the Netcatty UI.",
  "vault.host.import":
    "Only for text in known export formats (PuTTY reg, MobaXterm ini, CSV template, SecureCRT, ssh_config). If attached host text is unknown or auto-detection fails, use read_attachment content, extract fields yourself, and call vault_hosts_create.",
  "vault.hosts.create":
    "Use when the user wants to add/create a host in Vault → Hosts (创建主机、SSH 连接凭据). NOT for Vault → Notes sidebar docs. Put SSH password in password, or a local private-key file path in keyPath. If that key is encrypted and the user supplied its passphrase, put it in passphrase so later connections do not prompt. Put long remarks/admin tables in host notes. Never fall back to vault_notes_create if this fails.",
  "vault.host.update":
    "Update only fields the user requested. Use vault_hosts_list first to resolve hostId. Empty group, tags, notes, password, keyPath, or passphrase values clear those fields or saved credentials.",
  "vault.host.delete":
    "Permanently deletes one saved host. Use vault_hosts_list first to resolve hostId and rely on the normal write approval flow before deleting.",
  "vault.note.create":
    "Use ONLY when the user wants markdown documentation in Vault → Notes sidebar (保险箱笔记). Do NOT use when the user asked to create/add a host — use vault_hosts_create instead.",
  "vault.note.update":
    "Update an existing Vault → Notes entry (visible in the vault notes sidebar).",
  "vault.snippets.run":
    "Text snippets (kind=snippet) paste shell commands with optional {{variables}}. Scripts (kind=script) run via nct JavaScript runtime — use scripts_run for script-only workflows.",
  "vault.snippets.create":
    "Create vault snippets (shell text) or scripts (kind=script, nct JavaScript). For multi-step terminal automation use kind=script and call scripts_reference.",
  "vault.scripts.run":
    "Runs automation scripts in the nct JavaScript sandbox. Use wait=true to block until completion. Prefer over terminal_execute for await nct.screen.* workflows.",
  "vault.scripts.create":
    "Create nct automation scripts. Call scripts_reference first to learn the nct API, triggers, and source wrapping rules.",
  "vault.scripts.reference":
    "Returns full Netcatty automation script syntax reference (nct API, triggers, host targeting). Read before authoring scripts.",
  "vault.host.connectScripts.set":
    "Sets per-host onConnect script queue order. Global and matching dynamic-group scripts run first automatically.",
});

module.exports = {
  TOOL_INPUT_FIELDS,
  MODEL_DESCRIPTION_HINTS,
};
