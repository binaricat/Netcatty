/**
 * AI Bridge - Handles AI provider API calls and agent tool execution
 *
 * Proxies LLM API calls through the main process (avoiding CORS),
 * and provides tool execution capabilities for the Catty Agent.
 */

const https = require("node:https");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { existsSync } = fs;

const mcpServerBridge = require("./mcpServerBridge.cjs");
const { getCliLauncherPath, TOOL_CLI_DISCOVERY_ENV_VAR } = require("../cli/discoveryPath.cjs");
const {
  scanUserSkills,
  buildUserSkillsContext,
  toPublicUserSkillsStatus,
} = require("./ai/userSkills.cjs");
const { registerProviderHandlers } = require("./aiBridge/providerHandlers.cjs"), { registerCattyExecHandlers } = require("./aiBridge/cattyExecHandlers.cjs"), { createAgentCliHelpers } = require("./aiBridge/agentCliHelpers.cjs");
const { registerAgentDiscoveryHandlers } = require("./aiBridge/agentDiscoveryHandlers.cjs"), { registerAgentProcessHandlers } = require("./aiBridge/agentProcessHandlers.cjs"), { registerAcpHandlers } = require("./aiBridge/acpHandlers.cjs");

// ── Extracted modules ──
const {
  stripAnsi,
  normalizeCliPathForPlatform,
  prepareCommandForSpawn,
  normalizeClaudeCodeExecutableEnvForAcp,
  resolveCliFromPath,
  resolveClaudeAcpBinaryPath,
  isPlausibleCliVersionOutput,
  getShellEnv,
  getFreshIdlePrompt,
  invalidateShellEnvCache,
  serializeStreamChunk,
  toUnpackedAsarPath,
} = require("./ai/shellUtils.cjs");

const { detectClaudeAuthPresence, expandHomePath } = require("./ai/claudeAuth.cjs");

const CLAUDE_AUTH_HELP_MESSAGE =
  "Claude Code has no usable authentication. Open Settings -> AI -> Claude Code and set a Config directory (point it at a folder where you've run `claude` login) or add an ANTHROPIC_API_KEY under Environment variables. Alternatively, run `claude` in a terminal to log in.";

const {
  codexLoginSessions,
  resolveCodexAcpBinaryPath,
  appendCodexLoginOutput,
  toCodexLoginSessionResponse,
  getActiveCodexLoginSession,
  normalizeCodexIntegrationState,
  readCodexCustomProviderConfig,
  getCodexAuthOverride,
  getCodexCustomConfigPreflightError,
  extractCodexError,
  isCodexAuthError,
  getCodexAuthFingerprint,
  getCodexMcpFingerprint,
  invalidateCodexValidationCache,
  getCodexValidationCache,
  setCodexValidationCache,
} = require("./ai/codexHelpers.cjs");
const { normalizeAcpSessionModels } = require("./ai/acpModels.cjs");

const DEBUG_MCP = process.env.NETCATTY_MCP_DEBUG === "1";
const NETCATTY_TOOL_SKILL_PATH = toUnpackedAsarPath(
  path.resolve(__dirname, "../../skills/netcatty-tool-cli/SKILL.md"),
);
const NETCATTY_TOOL_LAUNCHER_PATH = getCliLauncherPath();
const NETCATTY_TOOL_CLI_PATH = toUnpackedAsarPath(
  path.resolve(__dirname, "../cli/netcatty-tool-cli.cjs"),
);

function debugMcpLog(...args) {
  if (!DEBUG_MCP) return;
  console.error("[AI Bridge:debug]", ...args);
}

function normalizeToolIntegrationMode(mode) {
  return mode === "skills" ? "skills" : "mcp";
}

function setToolIntegrationMode(mode) {
  // Tool access mode is selected per ACP request. The TCP bridge host is shared
  // by both MCP and Skills + CLI, so changing the setting must not tear down
  // unrelated in-flight sessions, approvals, or background jobs.
  return normalizeToolIntegrationMode(mode);
}

async function ensureSkillsCliHost() {
  return mcpServerBridge.getOrCreateHost();
}

function getSkillsCliInvocation() {
  if (existsSync(NETCATTY_TOOL_LAUNCHER_PATH)) {
    return {
      commandPrefix: `"${NETCATTY_TOOL_LAUNCHER_PATH}"`,
      launcherPath: NETCATTY_TOOL_LAUNCHER_PATH,
      usesLauncher: true,
    };
  }
  if (existsSync(NETCATTY_TOOL_CLI_PATH)) {
    return {
      commandPrefix: `node "${NETCATTY_TOOL_CLI_PATH}"`,
      launcherPath: null,
      usesLauncher: false,
    };
  }
  return {
    commandPrefix: "netcatty-tool-cli",
    launcherPath: null,
    usesLauncher: false,
  };
}

function buildExternalAgentContextualPrompt({ mode, prompt, chatSessionId, defaultTargetSession, userSkillsContext }) {
  const userSkillsPreamble = userSkillsContext ? `${userSkillsContext}\n\n` : "";
  if (mode === "skills") {
    const { commandPrefix: cliCommandPrefix, launcherPath, usesLauncher } = getSkillsCliInvocation();
    const skillHint = existsSync(NETCATTY_TOOL_SKILL_PATH)
      ? `The local Netcatty skill file is "${NETCATTY_TOOL_SKILL_PATH}". You do not need to read it for routine read-only requests if the host instructions here are sufficient. Only open it when the task is unusual, multi-step, or you are unsure about the workflow. `
      : "";
    const cliHint = usesLauncher
      ? (
        `For this chat session, the Netcatty CLI launcher is at \`${launcherPath}\`. ` +
        `Invoke that launcher directly for every Netcatty CLI call, and do not prepend \`node\`. ` +
        (process.platform === "win32"
          ? `If your execution surface supports argv-style execution, use that launcher path as the executable and pass subcommands/flags as separate arguments. If you need a literal shell command line, invoke it as \`${cliCommandPrefix}\`. `
          : `The literal shell command prefix is \`${cliCommandPrefix}\`. `)
      )
      : existsSync(NETCATTY_TOOL_CLI_PATH)
        ? `For this chat session, the exact Netcatty CLI command prefix is \`${cliCommandPrefix}\`.`
        : "Use the exact Netcatty CLI command prefix provided by the host application for this chat session. ";
    const scopeHint = chatSessionId
      ? `Always include \`--chat-session ${chatSessionId}\` on every Netcatty CLI call so you stay inside the current scoped session set. `
      : "";
    const defaultTargetHint = defaultTargetSession
      ? (
        `The host has already identified the default target session for this AI panel: ` +
        `sessionId="${defaultTargetSession.sessionId}", ` +
        `label="${defaultTargetSession.label || ""}", ` +
        `hostname="${defaultTargetSession.hostname || ""}", ` +
        `protocol="${defaultTargetSession.protocol || ""}", ` +
        `connected=${defaultTargetSession.connected !== false}. ` +
        (defaultTargetSession.connected !== false
          ? `For routine requests that do not mention another session or host, use this default target directly and prefer \`${cliCommandPrefix} session --session ${defaultTargetSession.sessionId} --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\` as the first call instead of starting with \`env\` discovery. Only run \`env\` when the user explicitly points to another session (for example with @), when the task is ambiguous, or when that direct session lookup fails. `
          : `This default target is currently not connected, so do not execute against it directly. Fall back to \`env\` / \`session\` lookup if the user may want another available session. `)
      )
      : "";
    const discoveryHint = defaultTargetSession?.connected !== false
      ? `If you do need discovery because the task is ambiguous or points to another session, start with \`${cliCommandPrefix} env --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\` to discover available sessions and their IDs. `
      : `Start with \`${cliCommandPrefix} env --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\` to discover available sessions and their IDs. `;

    return (
      `${userSkillsPreamble}` +
      `[Context: You are inside Netcatty, a multi-session terminal manager. ` +
      `${skillHint}` +
      `${cliHint}` +
      `${scopeHint}` +
      `${defaultTargetHint}` +
      `Use Skills + CLI instead of the "netcatty-remote-hosts" MCP server for Netcatty session access. ` +
      `First classify the task: remote command execution tasks go through \`exec\`, while remote file or directory tasks go through \`sftp\`. If the user explicitly says to avoid shell or \`exec\`, do not use \`exec\`. Treat \`exec\` as the short-command path only: use it only for commands expected to finish within about 60 seconds. For builds, scans, watch mode, tail-following, ping, or anything likely to exceed that budget or stream output for an extended period, do not use plain \`exec\`; use the long-running job commands instead. ` +
      `${discoveryHint}` +
      `After choosing a target session ID, call \`${cliCommandPrefix} session --session <id> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\` before executing anything. Do not infer protocol, shell type, device type, or connection readiness from the \`env\` result alone when you are about to run a command. ` +
      `For remote file operations, use the Netcatty SFTP CLI surface instead of trying to reconstruct SSH credentials or open your own SSH/SFTP connection, but only when the chosen session is SSH-backed and connected. After the required \`session --session <id>\` confirmation step, inspect the reported protocol, shell type, device type, and connected state before picking a file-operation path. For SSH-backed sessions, prefer one-off commands such as \`${cliCommandPrefix} sftp list --session <id> --remote-path <remote-path> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\`, \`${cliCommandPrefix} sftp read --session <id> --remote-path <remote-path> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\`, \`${cliCommandPrefix} sftp write --session <id> --remote-path <remote-path> --content <text> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\`, \`${cliCommandPrefix} sftp download --session <id> --remote-path <remote-path> --local-path <local-path> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\`, or \`${cliCommandPrefix} sftp upload --session <id> --local-path <local-path> --remote-path <remote-path> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\`. For local sessions, use normal local filesystem tools instead of Netcatty SFTP. For Mosh, Telnet, serial/raw, or network-device sessions, do not call SFTP; use a real SSH session, vendor CLI commands, or tell the user that the requested file transfer is unsupported on that transport. ` +
      `Keep local and remote path semantics strict: \`--remote-path\` always refers to the remote host, while \`--local-path\` always refers to the local machine running Netcatty. If the user asks to download a file to a local destination such as \`/tmp\`, \`~/Downloads\`, or a desktop path, use \`sftp download\`, not \`sftp read\` or \`sftp write\`. If the user asks to create or modify a file on the remote host, use \`sftp write\` or another remote SFTP operation, not \`sftp download\`. ` +
      `If you need to create or update a small text file with known content on the remote host, prefer \`${cliCommandPrefix} sftp write ...\` directly. Use \`sftp upload\` only when a real local file already exists and must be transferred to the remote host. Do not create temporary local files just to upload text that could be sent with \`sftp write\`. ` +
      `Keep SFTP usage one-off and explicit: every \`sftp\` command should include both \`--session <id>\` and \`--chat-session ${chatSessionId || "<chat-session-id>"}\`. Do not open reusable SFTP handles or use \`--sftp <id>\`. ` +
      `Run Netcatty CLI calls strictly one at a time. Do not issue concurrent or background Netcatty CLI commands for the same chat session, and always wait for each call to finish before starting the next one. ` +
      `For simple read-only requests such as hostname, IP address, CPU info, memory info, disk usage, pwd, whoami, uname, or process checks, use the shortest possible path: one \`env\`, one \`session\`, then one \`exec\`. Prefer a single straightforward command over creating helper scripts or multi-step shell orchestration. ` +
      `For long-running command tasks, start them with \`${cliCommandPrefix} job-start --session <id> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""} -- <command>\`, then use \`${cliCommandPrefix} job-poll --job <job-id> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\` to fetch incremental output, and \`${cliCommandPrefix} job-stop --job <job-id> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""}\` if the user asks to stop them. Do not poll aggressively; wait roughly 30 seconds between polls unless the output clearly justifies checking sooner. ` +
      `For those simple read-only requests, do not spend time reading extra files, designing scripts, or narrating a plan unless the first direct command fails or the session metadata shows a special device type. ` +
      `Do not create temporary scripts, JSON post-processing scripts, or extra wrapper commands unless the task genuinely requires logic that cannot fit cleanly in one direct command. ` +
      `Avoid shell command substitution such as \`$()\` and backticks, because Netcatty safety policy may block them. Prefer straightforward command chains such as \`hostname && hostname -I && lscpu\`. ` +
      `Avoid wrapping simple commands in \`sh -c\`, \`bash -c\`, or similar shell launcher patterns unless the task genuinely requires shell parsing that cannot be expressed as a direct command. ` +
      `Do not spend time narrating intent before every CLI call for routine read-only checks. Execute the minimal command sequence and then report the result. ` +
      `Only after that confirmation step should you call \`${cliCommandPrefix} exec --session <id> --json${chatSessionId ? ` --chat-session ${chatSessionId}` : ""} -- <command>\` for command execution. ` +
      `If the user stops the run or asks to abort outstanding Netcatty work, use \`${cliCommandPrefix} cancel --chat-session ${chatSessionId || "<chat-session-id>"} --json\`, and use \`resume\` to re-enable execs for that scope if needed. ` +
      `For serial/raw sessions and network device sessions (deviceType: network), commands are sent as-is without shell wrapping and exit codes are unavailable. Use vendor CLI commands directly.]\n\n${prompt}`
    );
  }

  return (
    `${userSkillsPreamble}` +
    `[Context: You are inside Netcatty, a multi-session terminal manager. ` +
    `Use the "netcatty-remote-hosts" MCP tools to operate only on the terminal sessions exposed by Netcatty. ` +
    `Those sessions may be remote hosts, a local terminal, or Mosh-backed shells. ` +
    `Call get_environment first to discover available sessions and their IDs. ` +
    `Use terminal_execute only for commands likely to finish within about 60 seconds. ` +
    `For long-running commands such as builds, scans, follow/log streaming, watch commands, or anything likely to exceed 60 seconds on PTY-backed shell sessions, use terminal_start, then terminal_poll until completed is true. Reuse the returned nextOffset for the next poll. If terminal_poll reports outputTruncated=true, only the retained tail starting at outputBaseOffset is still available. Do not poll aggressively: wait at least about 30 seconds between polls, and increase the interval further when there is no new output, to avoid wasting tokens. As soon as completed is true, stop polling and analyze the result immediately. ` +
    `Use terminal_stop if you need to interrupt a started long-running command. Note: terminal_start requires a PTY-backed session; for sessions that only support exec-channel execution (no writable PTY), use terminal_execute instead. ` +
    `For serial/raw sessions and network device sessions (deviceType: network), commands are sent as-is without shell wrapping and exit codes are unavailable. Use vendor CLI commands directly.]\n\n${prompt}`
  );
}

const { execViaPty } = require("./ai/ptyExec.cjs");

let sessions = null;
let sftpClients = null;
let electronModule = null;
let mainWebContentsId = null;
let cliDiscoveryFilePath = null;

// Active streaming requests (for cancellation)
const activeStreams = new Map();

// External agent processes
const agentProcesses = new Map();
const MAX_CONCURRENT_AGENTS = 5;

// ACP providers (module-level so cleanup() can access them)
const acpProviders = new Map();
const acpActiveStreams = new Map();
const acpRequestSessions = new Map();
const acpPendingCancelRequests = new Set();
const acpChatRuns = new Map();

// ── Provider registry (synced from renderer, keys stay encrypted) ──
const ENC_PREFIX = "enc:v1:";
let providerConfigs = [];
// Web search config (synced from renderer — apiKey stays encrypted, decrypted on use)
let webSearchApiHost = null;
let webSearchApiKeyEncrypted = null;

/**
 * Decrypt an API key using Electron's safeStorage.
 * Handles both encrypted (enc:v1: prefix) and plaintext keys.
 */
function decryptApiKeyValue(encryptedKey) {
  if (!encryptedKey || typeof encryptedKey !== "string") return encryptedKey || "";
  if (!encryptedKey.startsWith(ENC_PREFIX)) return encryptedKey; // plaintext
  const safeStorage = electronModule?.safeStorage;
  if (!safeStorage?.isEncryptionAvailable?.()) return encryptedKey; // cannot decrypt
  try {
    const base64 = encryptedKey.slice(ENC_PREFIX.length);
    const buf = Buffer.from(base64, "base64");
    return safeStorage.decryptString(buf);
  } catch (err) {
    console.warn("[AI Bridge] API key decryption failed:", err?.message || err);
    return "";
  }
}

/**
 * Look up a provider config by its id and decrypt its API key.
 * Returns { provider, apiKey } or null if not found.
 */
function resolveProviderApiKey(providerId) {
  if (!providerId) return null;
  const config = providerConfigs.find(p => p.id === providerId);
  if (!config) return null;
  return {
    provider: config,
    apiKey: decryptApiKeyValue(config.apiKey),
  };
}

function getAcpProviderAuthFingerprint(apiKey, provider, customConfig) {
  const parts = [
    typeof apiKey === "string" ? apiKey.trim() : "",
    typeof provider?.id === "string" ? provider.id.trim() : "",
    typeof provider?.providerId === "string" ? provider.providerId.trim() : "",
    typeof provider?.baseURL === "string" ? provider.baseURL.trim() : "",
    customConfig
      ? [
          "custom",
          customConfig.providerName || "",
          customConfig.baseUrl || "",
          customConfig.envKey || "",
          customConfig.envKeyPresent ? "1" : "0",
          // authHash changes when the user rotates their hardcoded api_key
          // or the env_key's resolved value; without it a cached ACP
          // provider would keep serving the stale key.
          customConfig.authHash || "",
        ].join(":")
      : "",
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return getCodexAuthFingerprint(parts.join("\n"));
}

/** Check if TLS verification should be skipped for a given provider. */
function shouldSkipTLSVerify(providerId) {
  if (!providerId) return false;
  const config = providerConfigs.find(p => p.id === providerId);
  return config?.skipTLSVerify === true;
}

/** Placeholder token used by the renderer to avoid sending real API keys over IPC. */
const API_KEY_PLACEHOLDER = "__IPC_SECURED__";
/** Placeholder for web search API key — replaced in main process before HTTP request. */
const WEB_SEARCH_KEY_PLACEHOLDER = "__WEB_SEARCH_KEY__";

/**
 * Replace the API key placeholder in HTTP headers and URL with the real decrypted key.
 * Handles OpenAI (Authorization: Bearer), Anthropic (x-api-key), Google (?key=), etc.
 */
function injectApiKeyIntoRequest(url, headers, providerId) {
  if (!providerId) return { url, headers };
  const resolved = resolveProviderApiKey(providerId);
  if (!resolved || !resolved.apiKey) return { url, headers };
  const realKey = resolved.apiKey;

  // Replace placeholder in all header values
  const patchedHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    patchedHeaders[k] = typeof v === "string" ? v.replace(API_KEY_PLACEHOLDER, realKey) : v;
  }

  // Replace placeholder in URL query parameters (e.g. Google AI ?key=)
  let patchedUrl = url;
  if (typeof url === "string" && url.includes(API_KEY_PLACEHOLDER)) {
    patchedUrl = url.replace(API_KEY_PLACEHOLDER, encodeURIComponent(realKey));
  }

  return { url: patchedUrl, headers: patchedHeaders };
}

function cleanupAcpProvider(chatSessionId) {
  // Clean up temporary COPILOT_HOME directory regardless of whether a
  // provider entry exists — prepareCopilotHome may have succeeded before
  // provider creation failed.
  try {
    const tempDirBridge = require("./tempDirBridge.cjs");
    const tempCopilotHome = path.join(tempDirBridge.getTempDir(), `copilot-home-${chatSessionId}`);
    if (existsSync(tempCopilotHome)) {
      fs.rmSync(tempCopilotHome, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }

  const entry = acpProviders.get(chatSessionId);
  if (!entry) return;
  cleanupAcpProviderInstance(entry.provider, chatSessionId);
  acpProviders.delete(chatSessionId);
}

function cleanupAcpProviderInstance(provider, chatSessionId = "transient") {
  if (!provider) return;
  const rootPid = provider?.model?.agentProcess?.pid;
  const childPids = getChildProcessTreePids(rootPid);
  try {
    if (typeof provider.forceCleanup === "function") {
      provider.forceCleanup();
    } else if (typeof provider.cleanup === "function") {
      provider.cleanup();
    }
  } catch (err) {
    console.warn("[ACP] Provider cleanup failed for session", chatSessionId, err?.message || err);
  }
  killTrackedProcessTree(rootPid, childPids);
}

function isActiveAcpRun(chatSessionId, requestId) {
  const activeRun = acpChatRuns.get(chatSessionId);
  return Boolean(activeRun && activeRun.requestId === requestId);
}

function shouldRetryFreshSession(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (message.includes("method not found") && message.includes("session/load"))
    || (message.includes("resource not found") && message.includes("session") && message.includes("not found"));
}

function getChildProcessTreePids(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  if (process.platform === "win32") return [];

  const discovered = new Set();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const output = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim();
      if (!output) continue;
      for (const line of output.split(/\s+/)) {
        const childPid = Number(line);
        if (!Number.isInteger(childPid) || childPid <= 0 || discovered.has(childPid)) continue;
        discovered.add(childPid);
        queue.push(childPid);
      }
    } catch {
      // No child processes or pgrep unavailable.
    }
  }

  return Array.from(discovered);
}

function killTrackedProcessTree(rootPid, childPids) {
  if (process.platform === "win32") {
    if (Number.isInteger(rootPid) && rootPid > 0) {
      try {
        execFileSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore kill failures; the process may have already exited.
      }
    }
    return;
  }

  const pids = [...(Array.isArray(childPids) ? childPids : [])];
  if (Number.isInteger(rootPid) && rootPid > 0) {
    pids.push(rootPid);
  }

  // Kill children before the wrapper so orphaned grandchildren do not survive.
  for (const pid of pids.reverse()) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore kill failures; the process may have already exited.
    }
  }
}

const { safeSend } = require("./ipcUtils.cjs");

function init(deps) {
  sessions = deps.sessions;
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
  cliDiscoveryFilePath = deps.cliDiscoveryFilePath || null;
  mcpServerBridge.init({ sessions, sftpClients, electronModule, cliDiscoveryFilePath });

  // Wire up main window getter for MCP approval IPC
  mcpServerBridge.setMainWindowGetter(() => {
    try {
      const windowManager = require("./windowManager.cjs");
      const mainWin = windowManager.getMainWindow?.();
      return (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
    } catch {
      return null;
    }
  });

  // Store main window webContents ID for IPC sender validation (Issue #17)
  try {
    const windowManager = require("./windowManager.cjs");
    const mainWin = windowManager.getMainWindow?.();
    if (mainWin && !mainWin.isDestroyed?.()) {
      mainWebContentsId = mainWin.webContents?.id ?? null;
    }
  } catch {
    // windowManager may not be available yet; will be set lazily
  }

}

function withCliDiscoveryEnv(env) {
  if (!cliDiscoveryFilePath) return env;
  return {
    ...env,
    [TOOL_CLI_DISCOVERY_ENV_VAR]: cliDiscoveryFilePath,
  };
}

/**
 * Validate that an IPC event sender is the main window.
 * Returns true if valid, false otherwise.
 */
function validateSender(event) {
  return _validateSenderImpl(event, false);
}

/**
 * Validate that an IPC event sender is a trusted window (main or settings).
 * Use this for handlers that the settings window legitimately needs access to
 * (e.g. model listing, provider sync, Codex login, agent discovery).
 */
function validateSenderOrSettings(event) {
  return _validateSenderImpl(event, true);
}

function _validateSenderImpl(event, allowSettings) {
  try {
    const windowManager = require("./windowManager.cjs");

    // Always resolve the current main window id to handle window recreation
    const mainWin = windowManager.getMainWindow?.();
    if (mainWin && !mainWin.isDestroyed?.()) {
      mainWebContentsId = mainWin.webContents?.id ?? null;
    }

    const senderId = event.sender?.id;
    if (senderId == null) return false;

    // Allow main window
    if (mainWebContentsId != null && senderId === mainWebContentsId) return true;

    // Allow settings window only for designated handlers
    if (allowSettings) {
      const settingsWin = windowManager.getSettingsWindow?.();
      if (settingsWin && !settingsWin.isDestroyed?.()) {
        if (senderId === settingsWin.webContents?.id) return true;
      }
    }

    return false;
  } catch {
    // Cannot resolve — reject for safety
    return false;
  }
}

function summarizeMcpServersForDebug(mcpServers) {
  if (!Array.isArray(mcpServers)) return [];
  return mcpServers.map((server) => ({
    name: server?.name || "",
    type: server?.type || "",
    command: server?.command || "",
    args: Array.isArray(server?.args) ? server.args : [],
    hasEnv: Array.isArray(server?.env) ? server.env.length > 0 : false,
    url: server?.url || "",
  }));
}

function logAcpDebug(agentLabel, message, details) {
  const prefix = `[ACP DEBUG][${agentLabel}]`;
  if (details === undefined) {
    console.log(prefix, message);
    return;
  }
  try {
    console.log(prefix, message, JSON.stringify(details));
  } catch {
    console.log(prefix, message, details);
  }
}

function normalizeAgentCommandName(command) {
  if (typeof command !== "string" || !command) return "";
  return path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

function matchesAgentCommand(command, expectedName) {
  if (typeof command !== "string" || typeof expectedName !== "string") return false;
  if (command.toLowerCase() === expectedName.toLowerCase()) return true;
  return normalizeAgentCommandName(command) === normalizeAgentCommandName(expectedName);
}

function envPairsToObject(entries) {
  if (!Array.isArray(entries)) return {};
  const result = {};
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string") continue;
    result[entry.name] = entry.value == null ? "" : String(entry.value);
  }
  return result;
}

function normalizeAgentEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || value == null) continue;
    result[key] = String(value);
  }
  // CLAUDE_CONFIG_DIR is consumed as a filesystem path by the spawned agent,
  // which won't shell-expand "~". Expand it here so "~/.claude" works and the
  // stored value stays portable (each device expands to its own home).
  if (result.CLAUDE_CONFIG_DIR) {
    result.CLAUDE_CONFIG_DIR = expandHomePath(result.CLAUDE_CONFIG_DIR);
  }
  return result;
}

function mapMcpServerToCopilotConfig(server) {
  if (!server || typeof server !== "object" || !server.name) return null;

  if (server.type === "stdio" || server.type === "local") {
    return {
      type: "local",
      command: server.command || "",
      args: Array.isArray(server.args) ? server.args : [],
      env: envPairsToObject(server.env),
      tools: ["*"],
    };
  }

  if (server.type === "http" || server.type === "sse") {
    return {
      type: server.type,
      url: server.url || "",
      headers: envPairsToObject(server.headers),
      tools: ["*"],
    };
  }

  return null;
}

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function prepareCopilotHome(shellEnv, mcpServers, chatSessionId) {
  const tempDirBridge = require("./tempDirBridge.cjs");
  const homeDir = shellEnv.HOME || process.env.HOME || process.env.USERPROFILE || "";
  const realCopilotHome = shellEnv.COPILOT_HOME || path.join(homeDir, ".copilot");
  const tempCopilotHome = path.join(tempDirBridge.getTempDir(), `copilot-home-${chatSessionId}`);

  try {
    fs.rmSync(tempCopilotHome, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures; mkdir/copy below will surface real issues if any.
  }

  fs.mkdirSync(tempCopilotHome, { recursive: true });

  if (realCopilotHome && existsSync(realCopilotHome)) {
    fs.cpSync(realCopilotHome, tempCopilotHome, { recursive: true });
  }

  const configPath = path.join(tempCopilotHome, "mcp-config.json");
  const baseConfig = safeReadJson(configPath) || { mcpServers: {} };
  const mergedServers = { ...(baseConfig.mcpServers || {}) };

  for (const server of Array.isArray(mcpServers) ? mcpServers : []) {
    const mapped = mapMcpServerToCopilotConfig(server);
    if (!mapped) continue;
    mergedServers[server.name] = mapped;
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...baseConfig, mcpServers: mergedServers }, null, 2),
    { mode: 0o600 },
  );

  return {
    copilotHome: tempCopilotHome,
    configPath,
    serverNames: Object.keys(mergedServers),
  };
}

/**
 * Make a streaming HTTP request and forward SSE events back to renderer
 */
/**
 * Start a streaming HTTP request. The returned promise resolves as soon as
 * the HTTP response headers arrive (with { statusCode, statusText }) so the
 * renderer can construct a Response with the real status. Data continues to
 * flow via stream:data / stream:end / stream:error IPC events.
 */
function streamRequest(url, options, event, requestId, skipTLS) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;

    // Store an AbortController before starting the request so that
    // cancellation requests arriving before the http.request callback
    // are not lost (fixes a race between request start and activeStreams.set).
    const controller = new AbortController();
    activeStreams.set(requestId, controller);

    // If already aborted (cancel arrived before we even got here), bail out.
    if (controller.signal.aborted) {
      activeStreams.delete(requestId);
      resolve({ statusCode: 0, statusText: "Aborted" });
      return;
    }

    const reqOpts = {
        method: options.method || "POST",
        headers: options.headers || {},
        timeout: 120000, // 2 min connection timeout
    };
    if (skipTLS && isHttps) reqOpts.rejectUnauthorized = false;

    const req = lib.request(parsedUrl, reqOpts,
      (res) => {
        const statusCode = res.statusCode || 0;
        const statusText = res.statusMessage || "";

        if (statusCode < 200 || statusCode >= 300) {
          // Read the error body before resolving so we can include it in the response
          let errorBody = "";
          res.on("data", (chunk) => { errorBody += chunk.toString(); });
          res.on("end", () => {
            // Try to extract error message from JSON response (OpenAI-compatible format)
            let errorDetail = statusText;
            try {
              const parsed = JSON.parse(errorBody);
              errorDetail = parsed?.error?.message || parsed?.message || parsed?.detail || errorBody.slice(0, 500);
            } catch {
              if (errorBody.trim()) errorDetail = errorBody.slice(0, 500);
            }
            safeSend(event.sender, "netcatty:ai:stream:error", {
              requestId,
              error: `HTTP ${statusCode}: ${errorDetail}`,
            });
            activeStreams.delete(requestId);
            resolve({ statusCode, statusText: `${statusCode} ${errorDetail}` });
          });
          return;
        }

        // Resolve with success status — data will flow via stream events
        resolve({ statusCode, statusText });

        let buffer = "";
        const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB safety limit

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          // Guard against unbounded buffer growth
          if (buffer.length > MAX_BUFFER_SIZE) {
            safeSend(event.sender, "netcatty:ai:stream:error", {
              requestId,
              error: "Stream buffer exceeded maximum size (10MB)",
            });
            req.destroy();
            activeStreams.delete(requestId);
            return;
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Forward raw SSE data line to renderer
            if (trimmed.startsWith("data: ")) {
              safeSend(event.sender, "netcatty:ai:stream:data", {
                requestId,
                data: trimmed.slice(6),
              });
            }
          }
        });

        res.on("end", () => {
          // Flush any remaining buffer
          if (buffer.trim().startsWith("data: ")) {
            safeSend(event.sender, "netcatty:ai:stream:data", {
              requestId,
              data: buffer.trim().slice(6),
            });
          }
          safeSend(event.sender, "netcatty:ai:stream:end", { requestId });
          activeStreams.delete(requestId);
        });

        res.on("error", (err) => {
          safeSend(event.sender, "netcatty:ai:stream:error", {
            requestId,
            error: err.message,
          });
          activeStreams.delete(requestId);
        });
      }
    );

    req.on("error", (err) => {
      safeSend(event.sender, "netcatty:ai:stream:error", {
        requestId,
        error: err.message,
      });
      activeStreams.delete(requestId);
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      safeSend(event.sender, "netcatty:ai:stream:error", {
        requestId,
        error: "Request timeout",
      });
      activeStreams.delete(requestId);
    });

    // Wire up abort signal to destroy the request
    controller.signal.addEventListener("abort", () => {
      req.destroy();
    }, { once: true });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}


function createHandlerContext(ipcMain) {
  return {
    ipcMain,
    require,
    https,
    http,
    path,
    URL,
    randomUUID,
    spawn,
    execFileSync,
    fs,
    existsSync,
    mcpServerBridge,
    getCliLauncherPath,
    TOOL_CLI_DISCOVERY_ENV_VAR,
    scanUserSkills,
    buildUserSkillsContext,
    toPublicUserSkillsStatus,
    stripAnsi,
    normalizeCliPathForPlatform,
    prepareCommandForSpawn,
    normalizeClaudeCodeExecutableEnvForAcp,
    resolveCliFromPath,
    resolveClaudeAcpBinaryPath,
    isPlausibleCliVersionOutput,
    getShellEnv,
    getFreshIdlePrompt,
    invalidateShellEnvCache,
    serializeStreamChunk,
    toUnpackedAsarPath,
    detectClaudeAuthPresence,
    expandHomePath,
    CLAUDE_AUTH_HELP_MESSAGE,
    codexLoginSessions,
    resolveCodexAcpBinaryPath,
    appendCodexLoginOutput,
    toCodexLoginSessionResponse,
    getActiveCodexLoginSession,
    normalizeCodexIntegrationState,
    readCodexCustomProviderConfig,
    getCodexAuthOverride,
    getCodexCustomConfigPreflightError,
    extractCodexError,
    isCodexAuthError,
    getCodexAuthFingerprint,
    getCodexMcpFingerprint,
    invalidateCodexValidationCache,
    getCodexValidationCache,
    setCodexValidationCache,
    normalizeAcpSessionModels,
    DEBUG_MCP,
    NETCATTY_TOOL_SKILL_PATH,
    NETCATTY_TOOL_LAUNCHER_PATH,
    NETCATTY_TOOL_CLI_PATH,
    debugMcpLog,
    normalizeToolIntegrationMode,
    setToolIntegrationMode,
    ensureSkillsCliHost,
    getSkillsCliInvocation,
    buildExternalAgentContextualPrompt,
    execViaPty,
    get sessions() { return sessions; },
    set sessions(value) { sessions = value; },
    get sftpClients() { return sftpClients; },
    set sftpClients(value) { sftpClients = value; },
    get electronModule() { return electronModule; },
    set electronModule(value) { electronModule = value; },
    get mainWebContentsId() { return mainWebContentsId; },
    set mainWebContentsId(value) { mainWebContentsId = value; },
    get cliDiscoveryFilePath() { return cliDiscoveryFilePath; },
    set cliDiscoveryFilePath(value) { cliDiscoveryFilePath = value; },
    activeStreams,
    agentProcesses,
    MAX_CONCURRENT_AGENTS,
    acpProviders,
    acpActiveStreams,
    acpRequestSessions,
    acpPendingCancelRequests,
    acpChatRuns,
    get providerConfigs() { return providerConfigs; },
    set providerConfigs(value) { providerConfigs = value; },
    get webSearchApiHost() { return webSearchApiHost; },
    set webSearchApiHost(value) { webSearchApiHost = value; },
    get webSearchApiKeyEncrypted() { return webSearchApiKeyEncrypted; },
    set webSearchApiKeyEncrypted(value) { webSearchApiKeyEncrypted = value; },
    decryptApiKeyValue,
    resolveProviderApiKey,
    getAcpProviderAuthFingerprint,
    shouldSkipTLSVerify,
    API_KEY_PLACEHOLDER,
    WEB_SEARCH_KEY_PLACEHOLDER,
    injectApiKeyIntoRequest,
    cleanupAcpProvider,
    cleanupAcpProviderInstance,
    isActiveAcpRun,
    shouldRetryFreshSession,
    getChildProcessTreePids,
    killTrackedProcessTree,
    safeSend,
    withCliDiscoveryEnv,
    validateSender,
    validateSenderOrSettings,
    summarizeMcpServersForDebug,
    logAcpDebug,
    normalizeAgentCommandName,
    matchesAgentCommand,
    envPairsToObject,
    normalizeAgentEnv,
    mapMcpServerToCopilotConfig,
    safeReadJson,
    prepareCopilotHome,
    streamRequest,
  };
}

function registerHandlers(ipcMain) {
  const context = createHandlerContext(ipcMain);
  Object.assign(context, createAgentCliHelpers(context));

  registerProviderHandlers(context);
  registerCattyExecHandlers(context);
  registerAgentDiscoveryHandlers(context);
  registerAgentProcessHandlers(context);
  registerAcpHandlers(context);

  ipcMain.handle("netcatty:ai:agent:kill", async (event, { agentId }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      proc.kill("SIGTERM");
      // Wait for the process to exit, or force-kill after 5 seconds
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (agentProcesses.has(agentId)) {
            try { proc.kill("SIGKILL"); } catch {}
          }
          resolve();
        }, 5000);
        proc.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      agentProcesses.delete(agentId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

// Cleanup all agent processes on shutdown
function cleanup() {
  for (const [id, proc] of agentProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  agentProcesses.clear();

  for (const [id, controller] of activeStreams) {
    try { controller.abort(); } catch {}
  }
  activeStreams.clear();

  // Abort active ACP streams
  for (const [id, controller] of acpActiveStreams) {
    try { controller.abort(); } catch {}
  }
  acpActiveStreams.clear();


  // Cleanup ACP providers (kills codex-acp child processes)
  for (const [id] of acpProviders) {
    cleanupAcpProvider(id);
  }

  for (const [id, session] of codexLoginSessions) {
    try {
      if (session.process && !session.process.killed) {
        session.process.kill("SIGTERM");
      }
    } catch {}
  }
  codexLoginSessions.clear();
  invalidateCodexValidationCache();
  mcpServerBridge.cleanup();
}

module.exports = { init, registerHandlers, cleanup };
