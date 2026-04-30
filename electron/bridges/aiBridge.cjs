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

// ── Extracted modules ──
const {
  stripAnsi,
  normalizeCliPathForPlatform,
  shouldUseShellForCommand,
  resolveCliFromPath,
  resolveClaudeAcpBinaryPath,
  getShellEnv,
  getFreshIdlePrompt,
  invalidateShellEnvCache,
  serializeStreamChunk,
  toUnpackedAsarPath,
} = require("./ai/shellUtils.cjs");

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

function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:ai:user-skills:status", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      const status = await scanUserSkills(electronModule?.app);
      return { ok: true, ...toPublicUserSkillsStatus(status) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:user-skills:open", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      const status = await scanUserSkills(electronModule?.app);
      const openResult = await electronModule?.shell?.openPath?.(status.directoryPath);
      return {
        ok: !openResult,
        error: openResult || undefined,
        ...toPublicUserSkillsStatus(status),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:user-skills:build-context", async (event, { prompt, selectedSkillSlugs }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      const { context, status } = await buildUserSkillsContext(electronModule?.app, prompt, selectedSkillSlugs);
      return { ok: true, context, status: toPublicUserSkillsStatus(status) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Provider config sync (renderer → main, keys stay encrypted) ──
  ipcMain.handle("netcatty:ai:sync-providers", async (event, { providers }) => {
    if (!validateSenderOrSettings(event)) return { ok: false };
    if (Array.isArray(providers)) {
      providerConfigs = providers;
      rebuildProviderFetchHosts();
    }
    return { ok: true };
  });

  // ── Web search config sync (renderer → main, for fetch allowlist + key decryption) ──
  ipcMain.handle("netcatty:ai:sync-web-search", async (event, { apiHost, apiKey }) => {
    if (!validateSenderOrSettings(event)) return { ok: false };
    webSearchApiHost = typeof apiHost === "string" ? apiHost : null;
    webSearchApiKeyEncrypted = typeof apiKey === "string" ? apiKey : null;
    rebuildProviderFetchHosts();
    return { ok: true };
  });

  /**
   * Inject the decrypted web search API key into request headers.
   * Replaces __WEB_SEARCH_KEY__ placeholder, similar to __IPC_SECURED__ for providers.
   */
  function injectWebSearchKeyIntoHeaders(headers) {
    if (!webSearchApiKeyEncrypted || !headers) return headers;
    const realKey = decryptApiKeyValue(webSearchApiKeyEncrypted);
    if (!realKey) return headers;
    const patched = {};
    for (const [k, v] of Object.entries(headers)) {
      patched[k] = typeof v === "string" ? v.replace(WEB_SEARCH_KEY_PLACEHOLDER, realKey) : v;
    }
    return patched;
  }

  // Temporarily add a host to the fetch allowlist (used by settings model listing).
  // Entries are auto-removed after 30 seconds unless they belong to a synced provider.
  const TEMP_ALLOWLIST_TTL = 30_000;
  // Track temporarily added entries so cleanup can distinguish them from synced ones
  const tempAllowedHosts = new Set();
  const tempAllowedPorts = new Set();
  // Track temporarily added HTTP hosts (for rebuild restoration)
  const tempHttpHosts = new Set();
  // Track active expiry timers per host to avoid duplicate/premature expiry
  const hostExpiryTimers = new Map();

  /** Check if a host is owned by a currently synced provider config */
  function isHostInProviderConfigs(host) {
    for (const config of providerConfigs) {
      if (!config.baseURL) continue;
      try { if (new URL(config.baseURL).hostname === host) return true; } catch {}
    }
    return false;
  }
  /** Check if a host is owned by a provider config that uses http:// */
  function isHttpHostInProviderConfigs(host) {
    for (const config of providerConfigs) {
      if (!config.baseURL) continue;
      try {
        const p = new URL(config.baseURL);
        if (p.hostname === host && p.protocol === "http:") return true;
      } catch {}
    }
    return false;
  }
  /** Check if a localhost port is owned by a currently synced provider config */
  function isPortInProviderConfigs(port) {
    for (const config of providerConfigs) {
      if (!config.baseURL) continue;
      try {
        const p = new URL(config.baseURL);
        if ((p.hostname === "localhost" || p.hostname === "127.0.0.1") &&
            Number(p.port || (p.protocol === "https:" ? 443 : 80)) === port) return true;
      } catch {}
    }
    return false;
  }

  ipcMain.handle("netcatty:ai:allowlist:add-host", async (event, { baseURL }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    if (typeof baseURL !== "string") return { ok: false, error: "baseURL must be a string" };
    try {
      const parsed = new URL(baseURL);
      const host = parsed.hostname;
      if (host === "localhost" || host === "127.0.0.1") {
        const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
        if (!ALLOWED_LOCALHOST_PORTS.has(port)) {
          ALLOWED_LOCALHOST_PORTS.add(port);
          tempAllowedPorts.add(port);
          setTimeout(() => {
            // Only remove if still temporary (not built-in and not synced by a provider)
            if (!BUILTIN_LOCALHOST_PORTS.includes(port) && !isPortInProviderConfigs(port)) {
              ALLOWED_LOCALHOST_PORTS.delete(port);
            }
            tempAllowedPorts.delete(port);
          }, TEMP_ALLOWLIST_TTL);
        }
      } else {
        const isNewHost = !providerFetchHosts.has(host);
        if (isNewHost) {
          providerFetchHosts.add(host);
        }
        // Always track in tempAllowedHosts so rebuild can restore to providerFetchHosts
        // even if the original persistent source (e.g. HTTPS provider) is removed mid-TTL
        tempAllowedHosts.add(host);
        if (parsed.protocol === "http:") {
          providerHttpHosts.add(host);
          if (!isHttpHostInProviderConfigs(host)) tempHttpHosts.add(host);
        }
        // Always (re-)schedule expiry timer to clean up temp entries
        const existing = hostExpiryTimers.get(host);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          hostExpiryTimers.delete(host);
          // Check if host is still needed by a provider config or web search
          const isWebSearchHost = webSearchApiHost && (() => {
            try { return new URL(webSearchApiHost).hostname === host; } catch { return false; }
          })();
          if (!isHostInProviderConfigs(host) && !isWebSearchHost) {
            providerFetchHosts.delete(host);
            providerHttpHosts.delete(host);
          } else if (!isHttpHostInProviderConfigs(host)) {
            providerHttpHosts.delete(host);
          }
          tempAllowedHosts.delete(host);
          tempHttpHosts.delete(host);
        }, TEMP_ALLOWLIST_TTL);
        hostExpiryTimers.set(host, timer);
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Invalid URL" };
    }
  });

  // URL allowlist: only permit requests to known AI provider domains + HTTPS
  const BUILTIN_FETCH_HOSTS = new Set([
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    // Web search providers
    "api.tavily.com",
    "api.exa.ai",
    "api.bochaai.com",
    "open.bigmodel.cn",
  ]);
  // Dynamically populated from configured provider baseURLs
  const providerFetchHosts = new Set();
  // Subset of providerFetchHosts where the provider baseURL explicitly uses http://
  const providerHttpHosts = new Set();

  /**
   * Rebuild the dynamic host allowlist from the current providerConfigs.
   * Called whenever providers are synced from the renderer.
   */
  function rebuildProviderFetchHosts() {
    providerFetchHosts.clear();
    providerHttpHosts.clear();
    // Reset localhost ports to built-in defaults, then add provider-configured ones
    ALLOWED_LOCALHOST_PORTS.clear();
    for (const port of BUILTIN_LOCALHOST_PORTS) ALLOWED_LOCALHOST_PORTS.add(port);
    // Re-add any still-active temporary entries so a sync doesn't wipe them
    for (const host of tempAllowedHosts) providerFetchHosts.add(host);
    for (const host of tempHttpHosts) providerHttpHosts.add(host);
    for (const port of tempAllowedPorts) ALLOWED_LOCALHOST_PORTS.add(port);
    for (const config of providerConfigs) {
      if (!config.baseURL) continue;
      try {
        const parsed = new URL(config.baseURL);
        const host = parsed.hostname;
        // Skip localhost — handled separately via port allowlist
        if (host === "localhost" || host === "127.0.0.1") {
          const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
          ALLOWED_LOCALHOST_PORTS.add(port);
        } else {
          providerFetchHosts.add(host);
          if (parsed.protocol === "http:") providerHttpHosts.add(host);
        }
      } catch {
        // Invalid URL in config — skip
      }
    }
    // Add web search apiHost if configured (e.g. SearXNG self-hosted instance)
    if (webSearchApiHost) {
      try {
        const parsed = new URL(webSearchApiHost);
        const host = parsed.hostname;
        if (host === "localhost" || host === "127.0.0.1") {
          const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
          ALLOWED_LOCALHOST_PORTS.add(port);
        } else {
          providerFetchHosts.add(host);
        }
      } catch {}
    }
  }

  // Allowed localhost ports to prevent SSRF (Issue #9)
  const BUILTIN_LOCALHOST_PORTS = [
    11434,  // Ollama default
    1234,   // LM Studio default
    3000,   // Common local dev
    3001,   // Common local dev
    5000,   // Common local dev
    5001,   // Common local dev
    8000,   // Common local dev
    8080,   // Common local dev
    8888,   // Common local dev
  ];
  const ALLOWED_LOCALHOST_PORTS = new Set(BUILTIN_LOCALHOST_PORTS);
  // RFC1918 / link-local / loopback / IPv6 private ranges — used by SSRF guard
  function isPrivateIp(ip) {
    if (!ip) return false;
    // Strip IPv6 brackets that URL.hostname may include
    const cleaned = ip.replace(/^\[|\]$/g, "");
    if (cleaned === "::1" || cleaned === "0.0.0.0" || cleaned === "::") return true;
    // IPv6 private ranges: fc00::/7 (unique local), fe80::/10 (link-local), ::ffff:127.x (mapped loopback)
    const lower = cleaned.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;   // fc00::/7
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 — extract IPv4 portion and check
      const v4 = lower.slice(7);
      return isPrivateIp(v4);
    }
    // IPv4
    const parts = cleaned.split(".");
    if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
      const [a, b] = parts.map(Number);
      if (a === 10) return true;                           // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
      if (a === 192 && b === 168) return true;             // 192.168.0.0/16
      if (a === 127) return true;                          // 127.0.0.0/8
      if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
      if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT (Tailscale etc.)
      if (a === 0) return true;                            // 0.0.0.0/8
    }
    return false;
  }

  function isPrivateHost(hostname) {
    if (hostname === "localhost") return true;
    // metadata endpoints (AWS, GCP, Azure)
    if (hostname === "metadata.google.internal") return true;
    return isPrivateIp(hostname);
  }

  function isAllowedFetchUrl(urlString, skipHostCheck) {
    try {
      const parsed = new URL(urlString);
      // Always block private/internal hosts when skipHostCheck is set (SSRF protection)
      if (skipHostCheck) {
        if (isPrivateHost(parsed.hostname)) return false;
        // Require HTTPS for skipHostCheck requests
        if (parsed.protocol !== "https:") return false;
        return true;
      }
      // Allow localhost/127.0.0.1 only on known ports (e.g. Ollama) — normal fetch path only
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
        return ALLOWED_LOCALHOST_PORTS.has(port);
      }
      // Only allow http: and https: schemes for remote hosts
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      // For HTTP, only allow providers explicitly configured with http:// or the web search apiHost
      if (parsed.protocol === "http:") {
        const isProviderHost = providerHttpHosts.has(parsed.hostname);
        let isWebSearchHost = false;
        if (webSearchApiHost) {
          try { isWebSearchHost = new URL(webSearchApiHost).hostname === parsed.hostname; } catch { }
        }
        if (!isProviderHost && !isWebSearchHost) return false;
      }
      // Check built-in + provider-configured host allowlist
      if (BUILTIN_FETCH_HOSTS.has(parsed.hostname)) return true;
      if (providerFetchHosts.has(parsed.hostname)) return true;
      return false;
    } catch {
      return false;
    }
  }

  // Start a streaming chat request (proxied through main process)
  ipcMain.handle("netcatty:ai:chat:stream", async (event, { requestId, url, headers, body, providerId }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    try {
      // Inject real API key if providerId is given (replaces placeholder in headers/URL)
      const patched = injectApiKeyIntoRequest(url, headers, providerId);
      const resolvedUrl = patched.url;
      const resolvedHeaders = patched.headers;

      // Validate URL: only allow HTTP(S) schemes
      try {
        const parsed = new URL(resolvedUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          return { ok: false, error: "Only HTTP(S) URLs are allowed" };
        }
      } catch {
        return { ok: false, error: "Invalid URL" };
      }

      // Check URL against allowed hosts (same as netcatty:ai:fetch)
      if (!isAllowedFetchUrl(resolvedUrl)) {
        return { ok: false, error: "URL host is not in the allowed list" };
      }

      const skipTLS = shouldSkipTLSVerify(providerId);
      const { statusCode, statusText } = await streamRequest(resolvedUrl, { method: "POST", headers: resolvedHeaders, body }, event, requestId, skipTLS);
      return { ok: true, statusCode, statusText };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Cancel an active stream
  ipcMain.handle("netcatty:ai:chat:cancel", async (event, { requestId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const controller = activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      activeStreams.delete(requestId);
      return true;
    }
    return false;
  });

  // Non-streaming request (for model listing, validation, etc.)
  ipcMain.handle("netcatty:ai:fetch", async (event, { url, method, headers, body, providerId, skipHostCheck, followRedirects, skipTLSVerify }) => {
    // Validate IPC sender — settings window needs this for model listing
    if (!validateSenderOrSettings(event)) {
      return { ok: false, status: 0, data: "", error: "Unauthorized IPC sender" };
    }

    // Inject real API key if providerId is given (replaces placeholder in headers/URL)
    const patched = injectApiKeyIntoRequest(url, headers, providerId);
    const resolvedUrl = patched.url;
    // Also inject web search API key if placeholder is present
    const resolvedHeaders = injectWebSearchKeyIntoHeaders(patched.headers);

    // Validate URL: block non-HTTP(S) schemes and internal network access
    try {
      const parsed = new URL(resolvedUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, status: 0, data: "", error: "Only HTTP(S) URLs are allowed" };
      }
      // Block file:// and other dangerous schemes (already covered above)
    } catch {
      return { ok: false, status: 0, data: "", error: "Invalid URL" };
    }

    // Check URL against allowed hosts; skipHostCheck allows public HTTPS but still blocks private/internal
    if (!isAllowedFetchUrl(resolvedUrl, !!skipHostCheck)) {
      return { ok: false, status: 0, data: "", error: "URL host is not in the allowed list" };
    }

    const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB safety limit
    const MAX_REDIRECTS = followRedirects ? 5 : 0;

    function doFetch(fetchUrl, redirectsLeft) {
      return new Promise((resolve) => {
        const parsedUrl = new URL(fetchUrl);
        const isHttps = parsedUrl.protocol === "https:";
        const lib = isHttps ? https : http;

        const fetchOpts = { method: method || "GET", headers: resolvedHeaders || {}, timeout: 30000 };
        if ((skipTLSVerify || shouldSkipTLSVerify(providerId)) && isHttps) fetchOpts.rejectUnauthorized = false;
        const req = lib.request(parsedUrl, fetchOpts,
          (res) => {
            // Handle redirects
            if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              const location = new URL(res.headers.location, fetchUrl).href;
              res.resume(); // drain the response
              // Revalidate the redirect target hostname (blocks localhost/metadata etc.)
              if (!isAllowedFetchUrl(location, !!skipHostCheck)) {
                resolve({ ok: false, status: 0, data: "", error: "Redirect target is not allowed" });
                return;
              }
              resolve(doFetch(location, redirectsLeft - 1));
              return;
            }
            let data = "";
            let totalSize = 0;
            res.on("data", (chunk) => {
              totalSize += chunk.length;
              if (totalSize > MAX_RESPONSE_SIZE) {
                req.destroy();
                resolve({ ok: false, status: 0, data: "", error: "Response body exceeded maximum size (10MB)" });
                return;
              }
              data += chunk.toString();
            });
            res.on("end", () => {
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                data,
              });
            });
          }
        );

        req.on("error", (err) => {
          resolve({ ok: false, status: 0, data: "", error: err.message });
        });
        req.on("timeout", () => {
          req.destroy();
          resolve({ ok: false, status: 0, data: "", error: "Request timeout" });
        });

        if (body) req.write(body);
        req.end();
      });
    }

    return doFetch(resolvedUrl, MAX_REDIRECTS);
  });

  // Execute a command on a terminal session (for Catty Agent)
  ipcMain.handle("netcatty:ai:exec", async (event, { sessionId, command, chatSessionId }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    // Block execution in observer mode (Issue #11)
    if (mcpServerBridge.getPermissionMode() === "observer") {
      return { ok: false, error: "Execution blocked: permission mode is 'observer'" };
    }
    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }

    // Honor the per-session execution lock so this IPC path does not race with
    // long-running background jobs started via terminal_start.
    const busyErr = mcpServerBridge.getSessionBusyError?.(sessionId);
    if (busyErr) return busyErr;
    const reservation = mcpServerBridge.reserveSessionExecution?.(sessionId, "exec");
    if (reservation && !reservation.ok) return reservation;
    const sessionToken = reservation?.token;
    const releaseLock = () => {
      if (sessionToken) {
        try { mcpServerBridge.releaseSessionExecution?.(sessionId, sessionToken); } catch {}
      }
    };

    // Look up device type from metadata (set by renderer from Host.deviceType).
    // Mosh sessions use a shell-backed PTY, so network device mode only applies to SSH/serial.
    // Prefer session.protocol (runtime truth) over meta.protocol (renderer hint)
    // because Mosh tabs report as protocol:"ssh" in metadata but "mosh" in session.
    const meta = mcpServerBridge.getSessionMeta(sessionId, chatSessionId) || {};
    const sessionProtocol = session.protocol || session.type || meta.protocol || "";
    const isSshOrSerial = sessionProtocol === "ssh" || sessionProtocol === "serial";
    const isNetworkDevice = (meta.deviceType === "network" && isSshOrSerial) || sessionProtocol === "serial";

    // Shell blocklist is meaningless on network device CLIs (e.g. "shutdown"
    // disables an interface on Cisco). Skip for network devices and serial sessions.
    if (!isNetworkDevice) {
      const safety = mcpServerBridge.checkCommandSafety(command);
      if (safety.blocked) {
        releaseLock();
        return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
      }
    }

    // Helper: ensure the session lock is released once the promise settles
    // (or immediately on a synchronous error/early return).
    const withLockRelease = (factory) => {
      try {
        const result = factory();
        return Promise.resolve(result).finally(releaseLock);
      } catch (err) {
        releaseLock();
        return { ok: false, error: err?.message || String(err) };
      }
    };

    try {
      if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
        releaseLock();
        return {
          ok: false,
          error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
        };
      }

      const ptyStream = session.stream || session.pty || session.proc;

      // Network devices (switches/routers) connected via SSH: use raw execution.
      // Their vendor CLIs don't run a POSIX shell, so shell-wrapped commands fail.
      if (isNetworkDevice && ptyStream && typeof ptyStream.write === "function") {
        const { execViaRawPty } = require("./ai/ptyExec.cjs");
        const timeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaRawPty(ptyStream, command, {
          timeoutMs,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          chatSessionId,
          encoding: "utf8", // SSH PTY streams use UTF-8, not latin1
        }));
      }

      // Prefer PTY stream (visible in terminal)
      if (ptyStream && typeof ptyStream.write === "function") {
        const timeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaPty(ptyStream, command, {
          stripMarkers: true,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          timeoutMs,
          shellKind: session.shellKind,
          chatSessionId,
          expectedPrompt: getFreshIdlePrompt(session),
          typedInput: true,
          echoCommand: (rawCommand) => {
            const contents = electronModule?.webContents?.fromId?.(session.webContentsId);
            safeSend(contents, "netcatty:data", {
              sessionId,
              data: `${rawCommand}\r\n`,
              syntheticEcho: true,
            });
          },
          // Catty Agent has no terminal_start fallback for long-running
          // commands, so do NOT enforce a hard wall-clock timeout here.
          // The inactivity timeout still applies, so genuinely hung
          // processes are still terminated.
        }));
      }

      // Network devices require an interactive PTY for raw command execution.
      if (isNetworkDevice) {
        releaseLock();
        return { ok: false, error: "Network device session has no writable PTY stream for command execution" };
      }

      // Fallback: SSH exec channel (invisible to terminal)
      const sshClient = session.sshClient || session.conn;
      if (sshClient && typeof sshClient.exec === "function") {
        const { execViaChannel } = require("./ai/ptyExec.cjs");
        const channelTimeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaChannel(sshClient, command, {
          timeoutMs: channelTimeoutMs,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          chatSessionId,
        }));
      }

      // Serial port: raw command execution (no shell wrapping)
      if (session.protocol === "serial" && session.serialPort && typeof session.serialPort.write === "function") {
        const { execViaRawPty } = require("./ai/ptyExec.cjs");
        const serialTimeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaRawPty(session.serialPort, command, {
          timeoutMs: serialTimeoutMs,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          chatSessionId,
          encoding: session.serialEncoding || "utf8",
        }));
      }

      releaseLock();
      return { ok: false, error: "No terminal stream or SSH client available for this session" };
    } catch (err) {
      releaseLock();
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Cancel in-flight Catty Agent command executions for a chat session
  ipcMain.handle("netcatty:ai:catty:cancel", async (event, { chatSessionId }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    mcpServerBridge.cancelPtyExecsForSession(chatSessionId);
    void mcpServerBridge.cancelSftpOpsForSession?.(chatSessionId);
    return { ok: true };
  });

  async function runCommand(command, args, options) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args || [], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options?.cwd || undefined,
        env: options?.env || process.env,
        shell: shouldUseShellForCommand(command),
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_BUFFER) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_BUFFER) {
          stderr += chunk.toString("utf8");
        }
      });

      child.once("error", (error) => {
        reject(error);
      });

      child.once("close", (exitCode) => {
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode,
        });
      });
    });
  }

  async function runCodexCli(args, options) {
    const shellEnv = await getShellEnv();
    const codexCliPath = resolveCliFromPath("codex", shellEnv) || "codex";
    return await runCommand(codexCliPath, args, {
      cwd: options?.cwd?.trim() || undefined,
      env: shellEnv,
    });
  }

  async function runCodexCliChecked(args, options) {
    const result = await runCodexCli(args, options);
    if (result.exitCode === 0) {
      return result;
    }

    const errorText =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `Codex command failed with exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(errorText);
  }

  async function validateCodexChatGptAuth(options) {
    const maxAgeMs = options?.maxAgeMs ?? 30000;
    const now = Date.now();
    const cached = getCodexValidationCache();
    if (cached && now - cached.checkedAt < maxAgeMs) {
      return cached;
    }

    const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
    const shellEnv = await getShellEnv();
    const resolvedCommand = resolveCodexAcpBinaryPath(shellEnv, electronModule);
    if (!resolvedCommand) {
      const result = { ok: false, checkedAt: now, error: "codex-acp binary not found", code: "ENOENT" };
      setCodexValidationCache(result);
      return result;
    }
    const provider = createACPProvider({
      command: resolvedCommand,
      env: shellEnv,
      session: {
        cwd: process.cwd(),
        mcpServers: [],
      },
      authMethodId: "chatgpt",
    });

    try {
      await provider.initSession();
      const result = { ok: true, checkedAt: now, error: null };
      setCodexValidationCache(result);
      return result;
    } catch (error) {
      const normalized = extractCodexError(error);
      const result = {
        ok: false,
        checkedAt: now,
        error: normalized.message,
        code: normalized.code,
      };
      setCodexValidationCache(result);
      return result;
    } finally {
      try {
        if (typeof provider.forceCleanup === "function") {
          provider.forceCleanup();
        } else if (typeof provider.cleanup === "function") {
          provider.cleanup();
        }
      } catch {
        // Ignore validation cleanup failures.
      }
    }
  }

  function objectToPairs(value) {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value)
      .filter(([name, val]) => typeof name === "string" && typeof val === "string")
      .map(([name, val]) => ({ name, value: val }));
  }

  function resolveCodexStdioEnv(transport, shellEnv) {
    const merged = {};

    if (transport?.env && typeof transport.env === "object") {
      for (const [name, value] of Object.entries(transport.env)) {
        if (typeof name === "string" && typeof value === "string") {
          merged[name] = value;
        }
      }
    }

    if (Array.isArray(transport?.env_vars)) {
      for (const envName of transport.env_vars) {
        const value = shellEnv[envName] || process.env[envName];
        if (typeof value === "string" && value.length > 0 && !merged[envName]) {
          merged[envName] = value;
        }
      }
    }

    return merged;
  }

  function resolveCodexHttpHeaders(transport, shellEnv) {
    const merged = {};

    if (transport?.http_headers && typeof transport.http_headers === "object") {
      for (const [name, value] of Object.entries(transport.http_headers)) {
        if (typeof name === "string" && typeof value === "string") {
          merged[name] = value;
        }
      }
    }

    if (transport?.env_http_headers && typeof transport.env_http_headers === "object") {
      for (const [headerName, envName] of Object.entries(transport.env_http_headers)) {
        if (typeof headerName !== "string" || typeof envName !== "string") continue;
        const value = shellEnv[envName] || process.env[envName];
        if (typeof value === "string" && value.length > 0) {
          merged[headerName] = value;
        }
      }
    }

    const bearerEnvVar = typeof transport?.bearer_token_env_var === "string"
      ? transport.bearer_token_env_var.trim()
      : "";
    if (bearerEnvVar && !merged.Authorization) {
      const token = shellEnv[bearerEnvVar] || process.env[bearerEnvVar];
      if (typeof token === "string" && token.trim()) {
        merged.Authorization = `Bearer ${token.trim()}`;
      }
    }

    return merged;
  }

  async function resolveCodexMcpSnapshot(cwd) {
    const empty = { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };

    try {
      const result = await runCodexCliChecked(["mcp", "list", "--json"], {
        cwd: cwd || undefined,
      });
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) {
        return empty;
      }

      const shellEnv = await getShellEnv();
      const mcpServers = [];

      for (const entry of parsed) {
        if (!entry?.enabled || !entry?.transport || typeof entry?.name !== "string") {
          continue;
        }

        const transportType = String(entry.transport.type || "").trim().toLowerCase();

        if (transportType === "stdio") {
          const command = String(entry.transport.command || "").trim();
          if (!command) continue;
          mcpServers.push({
            name: entry.name,
            type: "stdio",
            command,
            args: Array.isArray(entry.transport.args)
              ? entry.transport.args.filter((arg) => typeof arg === "string")
              : [],
            env: objectToPairs(resolveCodexStdioEnv(entry.transport, shellEnv)),
          });
          continue;
        }

        if (transportType === "streamable_http" || transportType === "http" || transportType === "sse") {
          const url = String(entry.transport.url || "").trim();
          if (!url) continue;
          mcpServers.push({
            name: entry.name,
            type: "http",
            url,
            headers: objectToPairs(resolveCodexHttpHeaders(entry.transport, shellEnv)),
          });
        }
      }

      return {
        mcpServers,
        fingerprint: getCodexMcpFingerprint(mcpServers),
      };
    } catch (err) {
      console.error("[Codex] Failed to resolve MCP servers:", err?.message || err);
      return empty;
    }
  }

  // Discover external agents from PATH, plus bundled ACP binaries if present.
  ipcMain.handle("netcatty:ai:agents:discover", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const agents = [];
    const knownAgents = [
      {
        command: "claude",
        name: "Claude Code",
        icon: "claude",
        description: "Anthropic's agentic coding assistant",
        acpCommand: "claude-agent-acp",
        acpArgs: [],
        args: ["-p", "--output-format", "text", "{prompt}"],
        resolveAcp: resolveClaudeAcpBinaryPath,
      },
      {
        command: "codex",
        name: "Codex CLI",
        icon: "openai",
        description: "OpenAI's coding agent",
        acpCommand: "codex-acp",
        acpArgs: [],
        args: ["exec", "--full-auto", "--json", "{prompt}"],
        resolveAcp: resolveCodexAcpBinaryPath,
      },
      {
        command: "copilot",
        name: "GitHub Copilot CLI",
        icon: "copilot",
        description: "GitHub's coding agent CLI",
        acpCommand: "copilot",
        acpArgs: ["--acp", "--stdio"],
        args: ["-p", "{prompt}"],
      },
    ];

    const shellEnv = await getShellEnv();
    const seenPaths = new Set();

    for (const agent of knownAgents) {
      let resolvedPath = resolveCliFromPath(agent.command, shellEnv);

      // If the base command is not on PATH, check whether the bundled ACP
      // binary is available — the agent can still work via ACP without the
      // standalone CLI installed.
      // resolveClaudeAcpBinaryPath returns { command, prependArgs },
      // resolveCodexAcpBinaryPath returns a plain string.
      let versionCommand = null;
      let versionPrependArgs = [];
      if (!resolvedPath && agent.resolveAcp) {
        const result = agent.resolveAcp(shellEnv, electronModule);
        if (typeof result === "string") {
          if (result && result !== agent.acpCommand && existsSync(result)) {
            resolvedPath = result;
          }
        } else if (result?.command) {
          // On Windows the command may be `node` with the script in prependArgs.
          // Use the script path for display/dedup so the UI shows the actual
          // agent rather than the Node binary.
          const scriptPath = result.prependArgs?.[0];
          const displayPath = scriptPath || result.command;
          if (displayPath !== agent.acpCommand && existsSync(displayPath)) {
            resolvedPath = displayPath;
            if (scriptPath) {
              versionCommand = result.command;
              versionPrependArgs = result.prependArgs;
            }
          }
        }
      }

      if (!resolvedPath || seenPaths.has(resolvedPath)) {
        continue;
      }

      let version = "";
      try {
        // When the agent is invoked via Node (Windows), probe version with
        // the full command (e.g. `node /path/to/dist/index.js --version`).
        const probeCmd = versionCommand || resolvedPath;
        const probeArgs = [...versionPrependArgs, "--version"];
        const result = await runCommand(probeCmd, probeArgs, { env: shellEnv });
        version = (result.stdout || result.stderr || "").trim().split("\n")[0];
      } catch {
        // --version failed: not a valid CLI executable (e.g. .app bundle)
        continue;
      }

      if (!version) continue;

      const { resolveAcp: _unused, ...agentInfo } = agent;
      agents.push({
        ...agentInfo,
        acpCommand: agent.command === "copilot" ? resolvedPath : agentInfo.acpCommand,
        path: resolvedPath,
        version,
        available: true,
      });
      seenPaths.add(resolvedPath);
    }

    return agents;
  });

  // Resolve a CLI binary path (auto-detect or validate custom path)
  ipcMain.handle("netcatty:ai:resolve-cli", async (event, { command, customPath }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const shellEnv = await getShellEnv();
    let resolvedPath = null;

    if (customPath) {
      // Normalize Windows shim paths like `codex` -> `codex.cmd` when present.
      // Fall back to PATH search if the stored path no longer exists
      // (e.g. CLI reinstalled to a different location).
      resolvedPath = normalizeCliPathForPlatform(customPath) || resolveCliFromPath(command, shellEnv);
    } else {
      resolvedPath = resolveCliFromPath(command, shellEnv);
    }

    if (!resolvedPath) {
      return { path: null, version: null, available: false };
    }

    let version = "";
    try {
      const result = await runCommand(resolvedPath, ["--version"], { env: shellEnv });
      version = (result.stdout || result.stderr || "").trim().split("\n")[0];
    } catch {
      // --version failed: not a valid CLI executable
      return { path: resolvedPath, version: null, available: false };
    }

    if (!version) {
      return { path: resolvedPath, version: null, available: false };
    }

    return { path: resolvedPath, version, available: true };
  });

  ipcMain.handle("netcatty:ai:codex:get-integration", async (event, options) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    // When the user clicks "Refresh Status" in Settings we also want to
    // rescan the shell env — otherwise a newly-exported variable in
    // .zshrc stays invisible until they restart netcatty entirely.
    if (options && options.refreshShellEnv) {
      invalidateShellEnvCache();
    }
    try {
      const result = await runCodexCli(["login", "status"]);
      const rawOutput = [result.stdout, result.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      let state = normalizeCodexIntegrationState(rawOutput);
      let effectiveRawOutput = rawOutput;

      if (state === "connected_chatgpt") {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"]);
            } catch {
              // Ignore logout failures; we still want to surface the invalid state.
            }
            invalidateCodexValidationCache();
            state = "not_logged_in";
          } else {
            state = "unknown";
          }

          effectiveRawOutput = [
            rawOutput,
            "",
            "ChatGPT auth validation failed:",
            validation.error || "Unknown validation error",
          ].join("\n").trim();
        }
      }

      // `codex login status` only reflects ~/.codex/auth.json. A user who
      // configured a custom provider directly in ~/.codex/config.toml is
      // functional from the CLI but would look "not_logged_in" here. Probe
      // config.toml so we can surface that as a valid ready state instead of
      // pushing the user into the ChatGPT login flow.
      let customConfig = null;
      if (state !== "connected_chatgpt" && state !== "connected_api_key") {
        try {
          const shellEnv = await getShellEnv();
          customConfig = readCodexCustomProviderConfig(shellEnv);
          if (customConfig) {
            state = "connected_custom_config";
          }
        } catch {
          customConfig = null;
        }
      }

      return {
        state,
        isConnected:
          state === "connected_chatgpt" ||
          state === "connected_api_key" ||
          state === "connected_custom_config",
        rawOutput: effectiveRawOutput,
        exitCode: result.exitCode,
        customConfig,
      };
    } catch (err) {
      return {
        state: "unknown",
        isConnected: false,
        rawOutput: err?.message || String(err),
        exitCode: null,
        customConfig: null,
      };
    }
  });

  ipcMain.handle("netcatty:ai:codex:start-login", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const existingSession = getActiveCodexLoginSession();
    if (existingSession) {
      return { ok: true, session: toCodexLoginSessionResponse(existingSession) };
    }

    try {
      const shellEnv = await getShellEnv();
      const codexCliPath = resolveCliFromPath("codex", shellEnv) || "codex";
      const sessionId = `codex_login_${randomUUID()}`;
      const child = spawn(codexCliPath, ["login"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: shellEnv,
        shell: shouldUseShellForCommand(codexCliPath),
        windowsHide: true,
      });

      const session = {
        id: sessionId,
        process: child,
        state: "running",
        output: "",
        url: null,
        error: null,
        exitCode: null,
      };

      const handleChunk = (chunk) => {
        appendCodexLoginOutput(session, chunk.toString("utf8"));
      };

      child.stdout.on("data", handleChunk);
      child.stderr.on("data", handleChunk);

      child.once("error", (error) => {
        session.state = "error";
        session.error = `[codex] Failed to start login flow: ${error.message}`;
        session.process = null;
      });

      child.once("close", (exitCode) => {
        session.exitCode = exitCode;
        session.process = null;

        if (session.state === "cancelled") {
          return;
        }

        if (exitCode === 0) {
          session.state = "success";
          session.error = null;
        } else {
          session.state = "error";
          session.error = session.error || `Codex login exited with code ${exitCode ?? "unknown"}`;
        }
      });

      codexLoginSessions.set(sessionId, session);
      invalidateCodexValidationCache();
      return { ok: true, session: toCodexLoginSessionResponse(session) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:codex:get-login-session", async (event, { sessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const session = codexLoginSessions.get(sessionId);
    if (!session) {
      return { ok: false, error: "Codex login session not found" };
    }
    return { ok: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:cancel-login", async (event, { sessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const session = codexLoginSessions.get(sessionId);
    if (!session) {
      return { ok: true, found: false };
    }

    session.state = "cancelled";
    session.error = null;
    if (session.process && !session.process.killed) {
      session.process.kill("SIGTERM");
    }

    invalidateCodexValidationCache();
    return { ok: true, found: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:logout", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      const logoutResult = await runCodexCli(["logout"]);
      invalidateCodexValidationCache();
      const statusResult = await runCodexCli(["login", "status"]);
      const rawOutput = [statusResult.stdout, statusResult.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      const state = normalizeCodexIntegrationState(rawOutput);

      return {
        ok: true,
        state,
        isConnected:
          state === "connected_chatgpt" ||
          state === "connected_api_key" ||
          state === "connected_custom_config",
        rawOutput,
        logoutOutput: [logoutResult.stdout, logoutResult.stderr]
          .filter((chunk) => chunk.trim().length > 0)
          .join("\n")
          .trim(),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Known agent command names (must match knownAgents in discover handler)
  const ALLOWED_AGENT_COMMANDS = new Set([
    "claude", "claude-agent-acp",
    "codex", "codex-acp",
    "copilot",
  ]);

  // Spawn an external agent process
  ipcMain.handle("netcatty:ai:agent:spawn", async (event, { agentId, command, args, env, closeStdin }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    // Validate command against known agent binaries (Issue #1)
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "Invalid command" };
    }
    // Reject absolute/relative paths — only bare command names allowed
    if (command.includes("/") || command.includes("\\")) {
      return { ok: false, error: "Absolute or relative paths are not allowed. Use a known agent command name." };
    }
    if (!ALLOWED_AGENT_COMMANDS.has(command)) {
      return { ok: false, error: `Unknown agent command: ${command}. Allowed: ${[...ALLOWED_AGENT_COMMANDS].join(", ")}` };
    }
    if (agentProcesses.has(agentId)) {
      return { ok: false, error: "Agent already running" };
    }
    if (agentProcesses.size >= MAX_CONCURRENT_AGENTS) {
      return { ok: false, error: `Concurrent agent limit reached (max ${MAX_CONCURRENT_AGENTS})` };
    }

    try {
      const shellEnv = await getShellEnv();
      const stdinMode = closeStdin ? "ignore" : "pipe";

      // Blocklist of dangerous environment variable names that could be used for code injection
      const DANGEROUS_ENV_KEYS = new Set([
        "LD_PRELOAD", "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
        "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
        "PYTHONPATH", "RUBYLIB", "PERL5LIB",
        "BASH_ENV", "ENV", "CDPATH", "PROMPT_COMMAND",
      ]);

      // Also block BASH_FUNC_* prefix keys (Issue #16)
      const isDangerousEnvKey = (k) =>
        DANGEROUS_ENV_KEYS.has(k) || k.startsWith("BASH_FUNC_");

      // Filter dangerous keys from user-provided env before merging
      const filteredUserEnv = {};
      if (env && typeof env === "object") {
        for (const [k, v] of Object.entries(env)) {
          if (!isDangerousEnvKey(k)) {
            filteredUserEnv[k] = v;
          }
        }
      }

      // Only pass safe environment variables to agent processes
      const SAFE_ENV_KEYS = new Set([
        "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
        "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
        // NODE_PATH omitted: can redirect module resolution (code injection vector)
        // CODEX_API_KEY omitted: injected separately at spawn site for Codex only
      ]);
      const safeEnv = {};
      for (const [k, v] of Object.entries(shellEnv)) {
        if (SAFE_ENV_KEYS.has(k) || k.startsWith("LC_") || k.startsWith("XDG_")) {
          safeEnv[k] = v;
        }
      }

      const proc = spawn(command, args || [], {
        stdio: [stdinMode, "pipe", "pipe"],
        env: { ...filteredUserEnv, ...safeEnv },
      });

      proc.stdout.on("data", (data) => {
        safeSend(event.sender, "netcatty:ai:agent:stdout", {
          agentId,
          data: data.toString(),
        });
      });

      proc.stderr.on("data", (data) => {
        safeSend(event.sender, "netcatty:ai:agent:stderr", {
          agentId,
          data: data.toString(),
        });
      });

      proc.on("exit", (code) => {
        agentProcesses.delete(agentId);
        safeSend(event.sender, "netcatty:ai:agent:exit", { agentId, code });
      });

      proc.on("error", (err) => {
        agentProcesses.delete(agentId);
        safeSend(event.sender, "netcatty:ai:agent:error", {
          agentId,
          error: err.message,
        });
      });

      agentProcesses.set(agentId, proc);

      return { ok: true, pid: proc.pid };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Send data to agent's stdin
  ipcMain.handle("netcatty:ai:agent:write", async (event, { agentId, data }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      if (!proc.stdin || proc.stdin.destroyed) {
        return { ok: false, error: "stdin not available" };
      }
      proc.stdin.write(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Close agent's stdin (signal EOF)
  ipcMain.handle("netcatty:ai:agent:close-stdin", async (event, { agentId }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── MCP Server session metadata ──

  ipcMain.handle("netcatty:ai:mcp:update-sessions", async (event, { sessions: sessionList, chatSessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.updateSessionMetadata(sessionList || [], chatSessionId);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-command-blocklist", async (event, { blocklist }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    // Validate: must be an array of strings, each a valid regex pattern
    if (!Array.isArray(blocklist)) {
      return { ok: false, error: "blocklist must be an array" };
    }
    const validPatterns = [];
    for (const pattern of blocklist) {
      if (typeof pattern !== "string") continue;
      try {
        new RegExp(pattern, "i"); // Validate regex
        validPatterns.push(pattern);
      } catch {
        // Skip invalid regex patterns silently
      }
    }
    mcpServerBridge.setCommandBlocklist(validPatterns);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-command-timeout", async (event, { timeout }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const value = Number(timeout);
    if (!Number.isFinite(value) || value < 1 || value > 3600) {
      return { ok: false, error: "timeout must be a number between 1 and 3600" };
    }
    mcpServerBridge.setCommandTimeout(value);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-max-iterations", async (event, { maxIterations }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const value = Number(maxIterations);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      return { ok: false, error: "maxIterations must be a number between 1 and 100" };
    }
    mcpServerBridge.setMaxIterations(value);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-permission-mode", async (event, { mode }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const validModes = ["observer", "confirm", "autonomous"];
    if (!validModes.includes(mode)) {
      return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
    }
    mcpServerBridge.setPermissionMode(mode);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-tool-integration-mode", async (event, { mode }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const validModes = ["mcp", "skills"];
    if (!validModes.includes(mode)) {
      return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
    }
    setToolIntegrationMode(mode);
    return { ok: true };
  });

  // ── MCP Approval response (renderer → main) ──
  ipcMain.handle("netcatty:ai:mcp:approval-response", async (event, { approvalId, approved }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.resolveApprovalFromRenderer(approvalId, approved);
    return { ok: true };
  });

  // ── ACP (Agent Client Protocol) streaming ──

  ipcMain.handle("netcatty:ai:acp:list-models", async (event, { acpCommand, acpArgs, cwd, providerId, chatSessionId }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }

    let provider = null;
    let copilotConfigInfo = null;
    try {
      const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
      const shellEnv = await getShellEnv();
      const sessionCwd = cwd || process.cwd();
      const isCodexAgent = matchesAgentCommand(acpCommand, "codex-acp");
      const isClaudeAgent = matchesAgentCommand(acpCommand, "claude-agent-acp");
      const isCopilotAgent = matchesAgentCommand(acpCommand, "copilot");
      const agentLabel = isCodexAgent ? "codex" : isClaudeAgent ? "claude" : isCopilotAgent ? "copilot" : acpCommand;

      const resolvedProvider = providerId ? resolveProviderApiKey(providerId) : null;
      const apiKey = resolvedProvider?.apiKey || undefined;

      // Mirror the stream handler's pre-flight: if Codex is pointed at a
      // config.toml custom provider whose env_key is not exported, surface
      // a targeted error instead of spawning codex-acp and letting it fail
      // mid-init with an opaque message.
      if (isCodexAgent && !apiKey) {
        const preflight = getCodexCustomConfigPreflightError(
          readCodexCustomProviderConfig(shellEnv),
        );
        if (preflight) {
          return { ok: false, models: [], error: preflight };
        }
      }

      const agentEnv = withCliDiscoveryEnv({ ...shellEnv });
      if (isCodexAgent && apiKey) {
        agentEnv.CODEX_API_KEY = apiKey;
      }
      if (isCodexAgent && resolvedProvider?.provider?.baseURL) {
        agentEnv.OPENAI_BASE_URL = resolvedProvider.provider.baseURL;
      }
      // Claude agent auth is owned entirely by its CLI config/login state
      // (`claude auth login`, ~/.claude settings, or ANTHROPIC_* in the user's
      // shell env). netcatty's provider list must not override it.

      if (isCopilotAgent) {
        copilotConfigInfo = prepareCopilotHome(shellEnv, [], chatSessionId || `models_${Date.now()}`);
        agentEnv.COPILOT_HOME = copilotConfigInfo.copilotHome;
      }

      const claudeAcp = isClaudeAgent ? resolveClaudeAcpBinaryPath(shellEnv, electronModule) : null;
      const resolvedCommand = isCodexAgent
        ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
        : claudeAcp
          ? claudeAcp.command
          : acpCommand;
      if (!resolvedCommand) {
        return { ok: false, models: [], error: `${agentLabel} binary not found` };
      }
      const resolvedArgs = claudeAcp
        ? [...claudeAcp.prependArgs, ...(acpArgs || [])]
        : acpArgs || [];

      provider = createACPProvider({
        command: resolvedCommand,
        args: resolvedArgs,
        env: agentEnv,
        session: {
          cwd: sessionCwd,
          mcpServers: [],
        },
        ...(isCodexAgent
          ? getCodexAuthOverride(apiKey, shellEnv)
          : isCopilotAgent
            ? { authMethodId: "copilot-login" }
            : {}),
      });

      const sessionInfo = await provider.initSession();
      const modelCatalog = normalizeAcpSessionModels(sessionInfo);

      if (isCopilotAgent) {
        logAcpDebug(agentLabel, "Fetched session models", {
          chatSessionId: chatSessionId || null,
          currentModelId: modelCatalog.currentModelId || null,
          availableModelIds: modelCatalog.models.map((modelInfo) => modelInfo.id),
          copilotHome: copilotConfigInfo?.copilotHome || null,
          copilotMcpConfigPath: copilotConfigInfo?.configPath || null,
        });
      }

      return {
        ok: true,
        currentModelId: modelCatalog.currentModelId || null,
        models: modelCatalog.models,
      };
    } catch (err) {
      console.error("[ACP] Failed to list models:", err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    } finally {
      try {
        cleanupAcpProviderInstance(provider, chatSessionId || "transient-model-list");
      } catch {
        // Ignore cleanup failures for transient model-discovery providers.
      }
      // Clean up transient COPILOT_HOME created for model listing
      if (copilotConfigInfo?.copilotHome) {
        try {
          fs.rmSync(copilotConfigInfo.copilotHome, { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
    }
  });

  ipcMain.handle("netcatty:ai:acp:stream", async (event, { requestId, chatSessionId, acpCommand, acpArgs, prompt, cwd, providerId, model, existingSessionId, historyMessages, images, toolIntegrationMode, defaultTargetSession, userSkillsContext }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    let abortController = null;
    try {
      const existingRun = acpChatRuns.get(chatSessionId);
      if (existingRun && existingRun.requestId !== requestId) {
        // Capture whether the prior run was already cancelled (via the
        // cancel IPC) BEFORE we set the flag ourselves — the cancel IPC
        // contract explicitly preserves the provider session so the
        // next prompt can continue in the same conversation. Tearing
        // down the provider here would silently break that contract in
        // the "click Stop, then immediately send next prompt" flow,
        // discarding the recovered ACP session.
        const alreadyCancelledViaIpc = existingRun.cancelRequested;
        existingRun.cancelRequested = true;
        const existingController = acpActiveStreams.get(existingRun.requestId);
        if (existingController) {
          existingController.abort();
          acpActiveStreams.delete(existingRun.requestId);
        }
        acpRequestSessions.delete(existingRun.requestId);
        // Only tear down the provider for true interrupt-and-restart
        // flows (user typed a new prompt while the old one was still
        // streaming, no explicit cancel). When we do skip cleanup here,
        // the reuse/reset logic below still handles auth/MCP/permission
        // changes correctly — the provider is preserved only when
        // nothing else would require rebuilding it.
        if (!alreadyCancelledViaIpc) {
          cleanupAcpProvider(chatSessionId);
        }
      }

      mcpServerBridge.setChatSessionCancelled?.(chatSessionId, false);
      abortController = new AbortController();
      acpActiveStreams.set(requestId, abortController);
      acpRequestSessions.set(requestId, chatSessionId);
      acpChatRuns.set(chatSessionId, { requestId, cancelRequested: false });

      const consumePendingStartupCancel = () => {
        if (!acpPendingCancelRequests.has(requestId)) return false;
        acpPendingCancelRequests.delete(requestId);
        abortController?.abort();
        return true;
      };

      const shouldAbortStartup = () =>
        Boolean(abortController?.signal?.aborted || consumePendingStartupCancel());

      const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
      const { streamText, stepCountIs } = require("ai");

      const shellEnv = await getShellEnv();
      if (shouldAbortStartup()) return { ok: true };
      const sessionCwd = cwd || process.cwd();
      const isCodexAgent = matchesAgentCommand(acpCommand, "codex-acp");
      const isClaudeAgent = matchesAgentCommand(acpCommand, "claude-agent-acp");
      const isCopilotAgent = matchesAgentCommand(acpCommand, "copilot");
      const agentLabel = isCodexAgent ? "codex" : isClaudeAgent ? "claude" : isCopilotAgent ? "copilot" : acpCommand;
      const effectiveToolIntegrationMode = normalizeToolIntegrationMode(toolIntegrationMode);
      debugMcpLog("ACP request start", {
        requestId,
        chatSessionId,
        acpCommand,
        acpArgs,
        model,
        providerId,
        sessionCwd,
        isCodexAgent,
        isClaudeAgent,
        toolIntegrationMode: effectiveToolIntegrationMode,
      });

      // Resolve API key from providerId (decrypted in main process only)
      const resolvedProvider = providerId ? resolveProviderApiKey(providerId) : null;
      const apiKey = resolvedProvider?.apiKey || undefined;

      // Probe ~/.codex/config.toml first so we can tell a ChatGPT user
      // (needs login validation) from a custom-provider user (must NOT be
      // forced through ChatGPT validation, since their auth lives in
      // config.toml / shell env, not auth.json).
      const codexCustomConfig = isCodexAgent && !apiKey
        ? readCodexCustomProviderConfig(shellEnv)
        : null;

      // Fail loud: custom-provider config is set but has no usable auth
      // material yet (env_key is named but not exported in the shell env,
      // and no api_key is hardcoded). Don't spawn — codex-acp would fail
      // mid-request with an opaque "Missing environment variable" error.
      const preflightError = getCodexCustomConfigPreflightError(codexCustomConfig);
      if (preflightError) {
        safeSend(event.sender, "netcatty:ai:acp:error", {
          requestId,
          error: preflightError,
        });
        return { ok: false, error: `Missing env var ${codexCustomConfig.envKey}` };
      }

      if (isCodexAgent && !apiKey && !codexCustomConfig) {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
        if (shouldAbortStartup()) return { ok: true };
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"]);
            } catch {
              // Ignore logout failures during recovery.
            }
            invalidateCodexValidationCache();
          }

          safeSend(event.sender, "netcatty:ai:acp:error", {
            requestId,
            error: `Codex ChatGPT login is stale or invalid. Reconnect Codex in Settings -> AI.\n\nDetails: ${validation.error || "Unknown authentication error"}`,
          });
          return { ok: false, error: validation.error || "Codex authentication validation failed" };
        }
      }

      const authFingerprint = isCodexAgent
        ? getAcpProviderAuthFingerprint(apiKey, resolvedProvider?.provider, codexCustomConfig)
        : null;
      const mcpSnapshot = isCodexAgent
        ? await resolveCodexMcpSnapshot(sessionCwd)
        : { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };
      if (shouldAbortStartup()) return { ok: true };

      setToolIntegrationMode(effectiveToolIntegrationMode);
      if (effectiveToolIntegrationMode === "skills") {
        try {
          await ensureSkillsCliHost();
        } catch (err) {
          const message = err?.message || String(err);
          safeSend(event.sender, "netcatty:ai:acp:error", {
            requestId,
            error: `Failed to initialize Netcatty Skills + CLI bridge.\n\nDetails: ${message}`,
          });
          return { ok: false, error: message };
        }
      }

      // Inject Netcatty MCP server for scoped terminal-session access only when
      // the user selected MCP mode. Skills mode uses the Netcatty CLI instead.
      if (effectiveToolIntegrationMode === "mcp") {
        try {
          const mcpPort = await mcpServerBridge.getOrCreateHost();
          const scopedIds = mcpServerBridge.getScopedSessionIds(chatSessionId);
          const netcattyMcpConfig = mcpServerBridge.buildMcpServerConfig(mcpPort, scopedIds, chatSessionId);
          mcpSnapshot.mcpServers.push(netcattyMcpConfig);
          debugMcpLog("Injected Netcatty MCP server", {
            requestId,
            chatSessionId,
            mcpPort,
            scopedIds,
            mcpServerNames: mcpSnapshot.mcpServers.map(server => server.name),
          });
          if (isCopilotAgent) {
            logAcpDebug(agentLabel, "Injected Netcatty MCP server into session", {
              chatSessionId,
              scopedIds,
              injectedServer: summarizeMcpServersForDebug([netcattyMcpConfig])[0],
            });
          }
        } catch (err) {
          console.error("[ACP] Failed to inject Netcatty MCP server:", err?.message || err);
        }
      }
      if (shouldAbortStartup()) return { ok: true };

      // Recalculate fingerprint after injection
      mcpSnapshot.fingerprint = getCodexMcpFingerprint(mcpSnapshot.mcpServers);

      const currentPermissionMode = mcpServerBridge.getPermissionMode();
      let providerEntry = acpProviders.get(chatSessionId);
      const shouldReuseProvider = Boolean(
        providerEntry &&
        providerEntry.acpCommand === acpCommand &&
        providerEntry.cwd === sessionCwd &&
        providerEntry.authFingerprint === authFingerprint &&
        providerEntry.mcpFingerprint === mcpSnapshot.fingerprint &&
        providerEntry.permissionMode === currentPermissionMode,
      );
      const shouldResetProviderForHistoryReplay = Boolean(
        shouldReuseProvider &&
        providerEntry?.historyReplayFallback &&
        Array.isArray(historyMessages) &&
        historyMessages.length > 0,
      );

      if (!shouldReuseProvider || shouldResetProviderForHistoryReplay) {
        const resumeSessionId = shouldResetProviderForHistoryReplay
          ? undefined
          : providerEntry?.provider?.getSessionId?.() || existingSessionId || undefined;
        // Preserve the replay-fallback flag across any recreation where
        // history recovery is still pending, not just the reset-for-replay
        // path. Otherwise a provider recreation driven by an orthogonal
        // change (permission mode / MCP scope / auth fingerprint) between
        // a still-empty recovered turn and its retry would drop the flag
        // and lose the recovered conversation on the next turn.
        //
        // Also hedge whenever we're spawning a brand-new provider process
        // that's being told to resume an existing session id (the common
        // app-restart / reconnect flow — #753). Some ACP agents (Copilot
        // CLI, some Codex builds) silently spin up a fresh session
        // instead of erroring with "session not found", so the catch-
        // block fallback below never fires and the agent ends up with
        // zero prior context. Scheduling a compact replay on the first
        // turn guarantees the agent sees durable constraints and the
        // last few raw turns even when session/load is effectively a
        // no-op. After the first successful streamed turn the flag
        // clears (post-stream hook), so steady-state cost stays at
        // just the latest prompt.
        const preserveHistoryReplayFallback =
          shouldResetProviderForHistoryReplay ||
          Boolean(
            providerEntry?.historyReplayFallback &&
            Array.isArray(historyMessages) &&
            historyMessages.length > 0,
          ) ||
          Boolean(
            resumeSessionId &&
            Array.isArray(historyMessages) &&
            historyMessages.length > 0,
          );
        cleanupAcpProvider(chatSessionId);

        const agentEnv = withCliDiscoveryEnv({ ...shellEnv });
        if (isCodexAgent && apiKey) {
          agentEnv.CODEX_API_KEY = apiKey;
        }
        if (isCodexAgent && resolvedProvider?.provider?.baseURL) {
          agentEnv.OPENAI_BASE_URL = resolvedProvider.provider.baseURL;
        }
        // See comment above: Claude auth is CLI-owned, not provider-driven.
        let copilotConfigInfo = null;
        if (isCopilotAgent) {
          copilotConfigInfo = prepareCopilotHome(shellEnv, mcpSnapshot.mcpServers, chatSessionId);
          agentEnv.COPILOT_HOME = copilotConfigInfo.copilotHome;
        }

        const claudeAcp = isClaudeAgent ? resolveClaudeAcpBinaryPath(shellEnv, electronModule) : null;
        const resolvedCommand = isCodexAgent
          ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
          : claudeAcp
            ? claudeAcp.command
            : acpCommand;
        if (!resolvedCommand) {
          throw new Error(`${agentLabel} binary not found`);
        }
        const resolvedArgs = claudeAcp
          ? [...claudeAcp.prependArgs, ...(acpArgs || [])]
          : acpArgs || [];
        const sessionMcpServers = isCopilotAgent ? [] : mcpSnapshot.mcpServers;

        const provider = createACPProvider({
          command: resolvedCommand,
          args: resolvedArgs,
          env: agentEnv,
          session: {
            cwd: sessionCwd,
            mcpServers: sessionMcpServers,
          },
          ...(resumeSessionId ? { existingSessionId: resumeSessionId } : {}),
          ...(isCodexAgent
            ? getCodexAuthOverride(apiKey, shellEnv)
            : isCopilotAgent
              ? { authMethodId: "copilot-login" }
            : {}),
          persistSession: true,
        });
        debugMcpLog("Created ACP provider", {
          requestId,
          chatSessionId,
          resolvedCommand,
          resolvedArgs,
          mcpServerNames: mcpSnapshot.mcpServers.map(server => server.name),
          authMethodId: isCodexAgent ? (getCodexAuthOverride(apiKey, shellEnv).authMethodId || null) : null,
        });

        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "Creating ACP provider", {
            requestId,
            chatSessionId,
            cwd: sessionCwd,
            resolvedCommand,
            resolvedArgs,
            sessionMcpServers: summarizeMcpServersForDebug(sessionMcpServers),
            copilotHome: copilotConfigInfo?.copilotHome || null,
            copilotMcpConfigPath: copilotConfigInfo?.configPath || null,
            copilotMcpServerNames: copilotConfigInfo?.serverNames || [],
          });
        }

        providerEntry = {
          provider,
          acpCommand,
          cwd: sessionCwd,
          authFingerprint,
          mcpFingerprint: mcpSnapshot.fingerprint,
          permissionMode: currentPermissionMode,
          historyReplayFallback: preserveHistoryReplayFallback,
        };
        acpProviders.set(chatSessionId, providerEntry);
      }
      let modelInstance = providerEntry.provider.languageModel(model || undefined);
      try {
        await providerEntry.provider.initSession(providerEntry.provider.tools);
        debugMcpLog("provider.initSession ok", {
          requestId,
          chatSessionId,
          providerSessionId: providerEntry.provider.getSessionId?.() || null,
        });
        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "ACP session initialized", {
            requestId,
            chatSessionId,
            providerSessionId: providerEntry.provider.getSessionId?.() || null,
            toolNames: Object.keys(providerEntry.provider.tools || {}),
          });
        }
        if (shouldAbortStartup()) return { ok: true };
      } catch (err) {
        debugMcpLog("provider.initSession error", {
          requestId,
          chatSessionId,
          message: err?.message || String(err),
        });
        const attemptedResumeSessionId = providerEntry.provider?.getSessionId?.() || existingSessionId;
        if (!attemptedResumeSessionId || !shouldRetryFreshSession(err)) {
          throw err;
        }

        cleanupAcpProvider(chatSessionId);

        const fallbackClaudeAcp = isClaudeAgent ? resolveClaudeAcpBinaryPath(shellEnv, electronModule) : null;
        const fallbackCommand = isCodexAgent
          ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
          : fallbackClaudeAcp
            ? fallbackClaudeAcp.command
            : acpCommand;
        if (!fallbackCommand) {
          throw new Error(`${agentLabel} binary not found`);
        }
        const fallbackProvider = createACPProvider({
          command: fallbackCommand,
          args: fallbackClaudeAcp
            ? [...fallbackClaudeAcp.prependArgs, ...(acpArgs || [])]
            : acpArgs || [],
          env: (() => {
            const fallbackEnv = withCliDiscoveryEnv(
              isCodexAgent && apiKey ? { ...shellEnv, CODEX_API_KEY: apiKey } : { ...shellEnv },
            );
            if (isCodexAgent && resolvedProvider?.provider?.baseURL) {
              fallbackEnv.OPENAI_BASE_URL = resolvedProvider.provider.baseURL;
            }
            // See comment above: Claude auth is CLI-owned, not provider-driven.
            if (isCopilotAgent) {
              const fallbackCopilotConfig = prepareCopilotHome(shellEnv, mcpSnapshot.mcpServers, chatSessionId);
              fallbackEnv.COPILOT_HOME = fallbackCopilotConfig.copilotHome;
            }
            return fallbackEnv;
          })(),
          session: {
            cwd: sessionCwd,
            mcpServers: isCopilotAgent ? [] : mcpSnapshot.mcpServers,
          },
          ...(isCodexAgent
            ? getCodexAuthOverride(apiKey, shellEnv)
            : isCopilotAgent
              ? { authMethodId: "copilot-login" }
            : {}),
          persistSession: true,
        });

        providerEntry = {
          provider: fallbackProvider,
          acpCommand,
          cwd: sessionCwd,
          authFingerprint,
          mcpFingerprint: mcpSnapshot.fingerprint,
          permissionMode: currentPermissionMode,
          historyReplayFallback: Array.isArray(historyMessages) && historyMessages.length > 0,
        };
        acpProviders.set(chatSessionId, providerEntry);
        modelInstance = providerEntry.provider.languageModel(model || undefined);
        await providerEntry.provider.initSession(providerEntry.provider.tools);
        debugMcpLog("fallback provider.initSession ok", {
          requestId,
          chatSessionId,
          providerSessionId: providerEntry.provider.getSessionId?.() || null,
        });
        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "ACP session initialized after fallback", {
            requestId,
            chatSessionId,
            providerSessionId: providerEntry.provider.getSessionId?.() || null,
            toolNames: Object.keys(providerEntry.provider.tools || {}),
          });
        }
        if (shouldAbortStartup()) return { ok: true };
      }
      const activeProviderSessionId = providerEntry.provider.getSessionId?.() || null;
      if (activeProviderSessionId) {
        safeSend(event.sender, "netcatty:ai:acp:event", {
          requestId,
          event: { type: "session-id", sessionId: activeProviderSessionId },
        });
      }

      // Prepend context hint so the agent uses the configured Netcatty access mode.
      const contextualPrompt = buildExternalAgentContextualPrompt({
        mode: effectiveToolIntegrationMode,
        prompt,
        chatSessionId,
        defaultTargetSession,
        userSkillsContext,
      });

      // Build message content: text + optional attachments
      // ACP provider only supports image/* and audio/* inline via `type: "file"`.
      // For other file types (PDF, text, etc.), tell the agent the original file
      // path so it can read it directly — ACP agents have local file access.
      function buildMessageContent(text, attachments) {
        if (!Array.isArray(attachments) || attachments.length === 0) {
          return text;
        }

        const content = [];
        const fileHints = [];

        for (const att of attachments) {
          if (!att.base64Data || !att.mediaType) continue;

          if (att.mediaType.startsWith("image/")) {
            // Images: pass inline as ACP-compatible file parts
            content.push({
              type: "file",
              mediaType: att.mediaType,
              data: att.base64Data,
              ...(att.filename ? { filename: att.filename } : {}),
            });
          } else if (att.filePath) {
            // Non-image files with a known local path: tell the agent to read it
            fileHints.push(`[Attached file "${att.filename || "file"}" is on the LOCAL machine (not a remote server), path: ${att.filePath} — read it locally]`);
          } else {
            // Pasted/virtual files without a path: save to managed temp dir so the agent can read them
            try {
              const fs = require("node:fs");
              const tempDirBridge = require("./tempDirBridge.cjs");
              const safeName = att.filename || `file-${Date.now()}`;
              const tempPath = tempDirBridge.getTempFilePath(safeName);
              fs.writeFileSync(tempPath, Buffer.from(att.base64Data, "base64"));
              fileHints.push(`[Attached file "${att.filename || safeName}" is on the LOCAL machine (not a remote server), path: ${tempPath} — read it locally]`);
            } catch (err) {
              console.error("[ACP] Failed to save pasted attachment to temp:", err?.message || err);
            }
          }
        }

        const fullText = fileHints.length > 0
          ? fileHints.join("\n") + "\n\n" + text
          : text;

        content.unshift({ type: "text", text: fullText });
        return content;
      }

      const latestPromptMessage = {
        role: "user",
        content: buildMessageContent(contextualPrompt, images),
      };
      const shouldReplayHistory = Boolean(
        providerEntry.historyReplayFallback &&
        Array.isArray(historyMessages) &&
        historyMessages.length > 0,
      );

      const result = streamText({
        model: modelInstance,
        messages: shouldReplayHistory
          ? [
              ...historyMessages.map((msg) => ({ role: msg.role, content: msg.content })),
              latestPromptMessage,
            ]
          : [latestPromptMessage],
        tools: providerEntry.provider.tools,
        stopWhen: stepCountIs(mcpServerBridge.getMaxIterations ? mcpServerBridge.getMaxIterations() : 20),
        abortSignal: abortController.signal,
      });
      const reader = result.fullStream.getReader();
      let hasContent = false;
      // Stall detection: if no chunk for 3s, send a status event
      let stallTimer = null;
      const STALL_TIMEOUT_MS = 3000;
      function resetStallTimer() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (!abortController.signal.aborted) {
            if (!isActiveAcpRun(chatSessionId, requestId)) return;
            safeSend(event.sender, "netcatty:ai:acp:event", {
              requestId,
              event: { type: "status", message: "Waiting for response from agent..." },
            });
          }
        }, STALL_TIMEOUT_MS);
      }
      resetStallTimer();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done || abortController.signal.aborted) break;
          if (!isActiveAcpRun(chatSessionId, requestId)) break;
          resetStallTimer();
          try {
            const serialized = serializeStreamChunk(chunk);
            if (!serialized || !serialized.type) continue;

            if (serialized.type === "text-delta" || serialized.type === "reasoning-delta" || serialized.type === "tool-call" || serialized.type === "tool-result") {
              hasContent = true;
            }
            if (isCopilotAgent && (serialized.type === "tool-call" || serialized.type === "tool-result" || serialized.type === "error" || serialized.type === "status")) {
              logAcpDebug(agentLabel, `Stream event: ${serialized.type}`, serialized);
            }
            debugMcpLog("ACP stream event", {
              requestId,
              chatSessionId,
              type: serialized.type,
              toolName: serialized.toolName || null,
            });
            safeSend(event.sender, "netcatty:ai:acp:event", {
              requestId,
              event: serialized,
            });
          } catch (serErr) {
            console.error("[ACP stream] Failed to serialize chunk:", chunk?.type, serErr?.message);
          }
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        reader.releaseLock();
      }

      // If stream completed with zero content, likely an auth or connection issue
      if (!hasContent && !abortController.signal.aborted) {
        debugMcpLog("ACP empty response", {
          requestId,
          chatSessionId,
          isCodexAgent,
          providerSessionId: providerEntry.provider.getSessionId?.() || null,
        });
        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "Stream completed with no content", {
            requestId,
            chatSessionId,
            providerSessionId: providerEntry.provider.getSessionId?.() || null,
          });
        }
        if (!isActiveAcpRun(chatSessionId, requestId)) {
          return { ok: true };
        }
        safeSend(event.sender, "netcatty:ai:acp:error", {
          requestId,
          error: isCodexAgent
            ? "Codex returned an empty response. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key."
            : "Agent returned an empty response.",
        });
      } else {
        // Clear replay fallback when the recovered turn either streamed
        // content OR was user-aborted. The empty-but-not-aborted case is
        // handled in the if-branch above and intentionally keeps the flag
        // so a follow-up retry can re-replay onto a fresh session.
        //
        // Why also clear on abort: if the user actively cancelled, the
        // freshly recovered ACP session has whatever state was built up so
        // far. Leaving the flag set would make the next turn trigger
        // shouldResetProviderForHistoryReplay, which discards the recovered
        // session (resumeSessionId is forced to undefined in that path) and
        // re-spends tokens on another compact replay. That breaks the
        // cancel-preserves-session contract for users who stop early.
        if (shouldReplayHistory) {
          providerEntry.historyReplayFallback = false;
        }
        debugMcpLog("ACP stream done", { requestId, chatSessionId, hasContent });
        if (!isActiveAcpRun(chatSessionId, requestId)) {
          return { ok: true };
        }
        safeSend(event.sender, "netcatty:ai:acp:done", { requestId });
      }
    } catch (err) {
      console.error("[ACP] Handler caught error:", err?.message || err, err?.stack?.split("\n").slice(0, 3).join("\n"));
      const normalized = extractCodexError(err);
      const errMsg = normalized.message;
      const isAuthErr = isCodexAuthError(normalized);

      if (isAuthErr) {
        console.error("[ACP] Auth error — user needs to re-login:", errMsg);
        cleanupAcpProvider(chatSessionId);
      }

      safeSend(event.sender, "netcatty:ai:acp:error", {
        requestId,
        error: isAuthErr
          ? `Authentication failed. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key.\n\nDetails: ${errMsg}`
          : errMsg,
      });
    } finally {
      acpActiveStreams.delete(requestId);
      acpRequestSessions.delete(requestId);
      acpPendingCancelRequests.delete(requestId);
      const activeRun = acpChatRuns.get(chatSessionId);
      if (activeRun?.requestId === requestId) {
        acpChatRuns.delete(chatSessionId);
      }
    }

    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:acp:cancel", async (event, { requestId, chatSessionId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const effectiveChatSessionId = chatSessionId || acpRequestSessions.get(requestId);
    const activeRun = effectiveChatSessionId ? acpChatRuns.get(effectiveChatSessionId) : null;
    const effectiveRequestId = requestId || activeRun?.requestId || "";
    // Cancel synchronous PTY executions scoped to this chat session (send Ctrl+C).
    // Do NOT cancel terminal_start background jobs here — they were intentionally
    // launched as long-running and should keep running when the user only wants
    // to stop the model's polling/output. Background jobs are still cleaned up
    // when the chat session itself is deleted (see cleanupScopedMetadata).
    mcpServerBridge.setChatSessionCancelled?.(effectiveChatSessionId, true);
    mcpServerBridge.cancelPtyExecsForSession(effectiveChatSessionId);
    mcpServerBridge.clearPendingApprovals(effectiveChatSessionId);
    if (activeRun && activeRun.requestId === effectiveRequestId) {
      activeRun.cancelRequested = true;
    }
    // Synchronously clear historyReplayFallback on the preserved provider
    // entry. Without this, a user pressing Stop and immediately sending
    // the next prompt can have their new request enter the stream
    // handler before the aborted run's post-stream clearing code runs.
    // The new turn would then see historyReplayFallback=true, trigger
    // shouldResetProviderForHistoryReplay, and recreate the provider
    // without the recovered existingSessionId — discarding the very
    // session the cancel contract promised to preserve.
    if (effectiveChatSessionId) {
      const preservedEntry = acpProviders.get(effectiveChatSessionId);
      if (preservedEntry) preservedEntry.historyReplayFallback = false;
    }
    const controller = acpActiveStreams.get(effectiveRequestId);
    let cancelled = false;
    if (controller) {
      controller.abort();
      acpActiveStreams.delete(effectiveRequestId);
      cancelled = true;
    } else if (effectiveRequestId) {
      acpPendingCancelRequests.add(effectiveRequestId);
      cancelled = true;
    }
    // Preserve the ACP provider session on stop so the next user message can
    // continue within the same persisted conversation context. Full provider
    // cleanup is handled by netcatty:ai:acp:cleanup when the chat is deleted.
    if (effectiveChatSessionId) cancelled = true;
    if (effectiveRequestId) acpRequestSessions.delete(effectiveRequestId);
    void mcpServerBridge.cancelSftpOpsForSession?.(effectiveChatSessionId);
    return cancelled ? { ok: true } : { ok: false, error: "Stream not found" };
  });

  // Cleanup a specific ACP session (when chat session is deleted)
  ipcMain.handle("netcatty:ai:acp:cleanup", async (event, { chatSessionId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.setChatSessionCancelled?.(chatSessionId, true);
    mcpServerBridge.cancelPtyExecsForSession(chatSessionId);
    cleanupAcpProvider(chatSessionId);
    await mcpServerBridge.cleanupScopedMetadata(chatSessionId);
    return { ok: true };
  });


  // Kill an agent process — waits for exit or force-kills after timeout
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
