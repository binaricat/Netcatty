/**
 * AI Bridge - Handles AI provider API calls and agent tool execution
 *
 * Proxies LLM API calls through the main process (avoiding CORS),
 * and provides tool execution capabilities for the Catty Agent.
 */

const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");
const { spawn, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const mcpServerBridge = require("./mcpServerBridge.cjs");

// ── Extracted modules ──
const {
  stripAnsi,
  resolveCliFromPath,
  getShellEnv,
  serializeStreamChunk,
} = require("./ai/shellUtils.cjs");

const {
  codexLoginSessions,
  resolveCodexAcpBinaryPath,
  appendCodexLoginOutput,
  toCodexLoginSessionResponse,
  getActiveCodexLoginSession,
  normalizeCodexIntegrationState,
  extractCodexError,
  isCodexAuthError,
  getCodexAuthFingerprint,
  getCodexMcpFingerprint,
  invalidateCodexValidationCache,
  getCodexValidationCache,
  setCodexValidationCache,
} = require("./ai/codexHelpers.cjs");


const { execViaPty } = require("./ai/ptyExec.cjs");

let sessions = null;
let sftpClients = null;
let electronModule = null;
let mainWebContentsId = null;

// Active streaming requests (for cancellation)
const activeStreams = new Map();

// External agent processes
const agentProcesses = new Map();
const MAX_CONCURRENT_AGENTS = 5;

// ACP providers (module-level so cleanup() can access them)
const acpProviders = new Map();
const acpActiveStreams = new Map();
const acpRequestSessions = new Map();

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
  const entry = acpProviders.get(chatSessionId);
  if (!entry) return;
  const rootPid = entry.provider?.model?.agentProcess?.pid;
  const childPids = getChildProcessTreePids(rootPid);
  try {
    if (typeof entry.provider.forceCleanup === "function") {
      entry.provider.forceCleanup();
    } else if (typeof entry.provider.cleanup === "function") {
      entry.provider.cleanup();
    }
  } catch (err) {
    console.warn("[ACP] Provider cleanup failed for session", chatSessionId, err?.message || err);
  }
  killTrackedProcessTree(rootPid, childPids);
  acpProviders.delete(chatSessionId);
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

/**
 * Safely send an IPC message to a renderer, guarding against destroyed senders.
 */
function safeSend(sender, channel, ...args) {
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, ...args);
  }
}

function init(deps) {
  sessions = deps.sessions;
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
  mcpServerBridge.init({ sessions, sftpClients });

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

  /** Check if a host is owned by a currently synced provider config */
  function isHostInProviderConfigs(host) {
    for (const config of providerConfigs) {
      if (!config.baseURL) continue;
      try { if (new URL(config.baseURL).hostname === host) return true; } catch {}
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
        if (!providerFetchHosts.has(host)) {
          providerFetchHosts.add(host);
          tempAllowedHosts.add(host);
          setTimeout(() => {
            // Only remove if not owned by a synced provider config
            if (!isHostInProviderConfigs(host)) {
              providerFetchHosts.delete(host);
            }
            tempAllowedHosts.delete(host);
          }, TEMP_ALLOWLIST_TTL);
        }
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

  /**
   * Rebuild the dynamic host allowlist from the current providerConfigs.
   * Called whenever providers are synced from the renderer.
   */
  function rebuildProviderFetchHosts() {
    providerFetchHosts.clear();
    // Reset localhost ports to built-in defaults, then add provider-configured ones
    ALLOWED_LOCALHOST_PORTS.clear();
    for (const port of BUILTIN_LOCALHOST_PORTS) ALLOWED_LOCALHOST_PORTS.add(port);
    // Re-add any still-active temporary entries so a sync doesn't wipe them
    for (const host of tempAllowedHosts) providerFetchHosts.add(host);
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
      // Require HTTPS for remote hosts; allow HTTP only for the configured web search apiHost
      // (e.g. self-hosted SearXNG at http://searxng.lan:8080 or http://192.168.x.x)
      if (parsed.protocol !== "https:") {
        if (!webSearchApiHost) return false;
        try {
          const wsHost = new URL(webSearchApiHost).hostname;
          if (parsed.hostname !== wsHost) return false;
        } catch {
          return false;
        }
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

      // Validate URL: only allow HTTP(S) schemes; require HTTPS for non-localhost
      try {
        const parsed = new URL(resolvedUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          return { ok: false, error: "Only HTTP(S) URLs are allowed" };
        }
        const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
        if (parsed.protocol === "http:" && !isLocalhost) {
          return { ok: false, error: "HTTP is only allowed for localhost" };
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
  ipcMain.handle("netcatty:ai:exec", async (event, { sessionId, command }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    // Block execution in observer mode (Issue #11)
    if (mcpServerBridge.getPermissionMode() === "observer") {
      return { ok: false, error: "Execution blocked: permission mode is 'observer'" };
    }
    // Check command against safety blocklist before executing
    const safety = mcpServerBridge.checkCommandSafety(command);
    if (safety.blocked) {
      return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
    }

    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }

    try {
      // Prefer PTY stream (visible in terminal)
      const ptyStream = session.stream || session.pty;
      if (ptyStream && typeof ptyStream.write === "function") {
        const timeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return execViaPty(ptyStream, command, { stripMarkers: true, timeoutMs });
      }

      // Fallback: SSH exec channel (invisible to terminal)
      const sshClient = session.sshClient || session.conn;
      if (sshClient && typeof sshClient.exec === "function") {
        const { execViaChannel } = require("./ai/ptyExec.cjs");
        const channelTimeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return execViaChannel(sshClient, command, { timeoutMs: channelTimeoutMs });
      }

      return { ok: false, error: "No terminal stream or SSH client available for this session" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Write to terminal session (send input like a user typing)
  ipcMain.handle("netcatty:ai:terminal:write", async (event, { sessionId, data }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    // Block writes in observer mode (Issue #11)
    if (mcpServerBridge.getPermissionMode() === "observer") {
      return { ok: false, error: "Terminal write blocked: permission mode is 'observer'" };
    }
    // Check input against safety blocklist before writing
    const safety = mcpServerBridge.checkCommandSafety(data);
    if (safety.blocked) {
      return { ok: false, error: `Input blocked by safety policy. Pattern: ${safety.matchedPattern}` };
    }

    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    try {
      if (session.stream) {
        session.stream.write(data);
        return { ok: true };
      }
      if (session.pty) {
        session.pty.write(data);
        return { ok: true };
      }
      return { ok: false, error: "No writable stream for session" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  async function runCommand(command, args, options) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args || [], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options?.cwd || undefined,
        env: options?.env || process.env,
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
    const provider = createACPProvider({
      command: resolveCodexAcpBinaryPath(shellEnv, electronModule),
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

  // Discover external agents from PATH, plus the bundled Codex CLI if present.
  ipcMain.handle("netcatty:ai:agents:discover", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const agents = [];
    const knownAgents = [
      {
        command: "claude",
        name: "Claude Code",
        icon: "claude",
        description: "Anthropic's agentic coding assistant",
        acpCommand: "claude-code-acp",
        acpArgs: [],
        args: ["-p", "--output-format", "text", "{prompt}"],
      },
      {
        command: "codex",
        name: "Codex CLI",
        icon: "openai",
        description: "OpenAI's coding agent",
        acpCommand: "codex-acp",
        acpArgs: [],
        args: ["exec", "--full-auto", "--json", "{prompt}"],
      },
    ];

    const shellEnv = await getShellEnv();
    const seenPaths = new Set();

    for (const agent of knownAgents) {
      let resolvedPath = null;

      try {
        const whichCmd = process.platform === "win32" ? "where" : "which";
        const result = execFileSync(whichCmd, [agent.command], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
          env: shellEnv,
        }).trim();
        if (result) {
          resolvedPath = result.split("\n")[0].trim();
        }
      } catch {
        resolvedPath = null;
      }

      if (!resolvedPath || seenPaths.has(resolvedPath)) {
        continue;
      }

      let version = "";
      try {
        const result = await runCommand(resolvedPath, ["--version"], { env: shellEnv });
        version = (result.stdout || result.stderr || "").trim().split("\n")[0];
      } catch {
        version = "";
      }

      agents.push({
        ...agent,
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
      // User provided a custom path – validate it exists
      if (existsSync(customPath)) {
        resolvedPath = customPath;
      }
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
      version = "";
    }

    return { path: resolvedPath, version, available: true };
  });

  ipcMain.handle("netcatty:ai:codex:get-integration", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
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

      return {
        state,
        isConnected: state === "connected_chatgpt" || state === "connected_api_key",
        rawOutput: effectiveRawOutput,
        exitCode: result.exitCode,
      };
    } catch (err) {
      return {
        state: "unknown",
        isConnected: false,
        rawOutput: err?.message || String(err),
        exitCode: null,
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
      const sessionId = `codex_login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const child = spawn(codexCliPath, ["login"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: shellEnv,
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
        isConnected: state === "connected_chatgpt" || state === "connected_api_key",
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
    "claude", "claude-code-acp",
    "codex", "codex-acp",
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

  // ── ACP (Agent Client Protocol) streaming ──

  ipcMain.handle("netcatty:ai:acp:stream", async (event, { requestId, chatSessionId, acpCommand, acpArgs, prompt, cwd, providerId, model, images }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    try {
      mcpServerBridge.setChatSessionCancelled?.(chatSessionId, false);
      const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
      const { streamText, stepCountIs } = require("ai");

      const shellEnv = await getShellEnv();
      const sessionCwd = cwd || process.cwd();
      const isCodexAgent = acpCommand === "codex-acp";

      // Resolve API key from providerId (decrypted in main process only)
      const resolvedProvider = providerId ? resolveProviderApiKey(providerId) : null;
      const apiKey = resolvedProvider?.apiKey || undefined;

      if (isCodexAgent && !apiKey) {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
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

      const authFingerprint = isCodexAgent ? getCodexAuthFingerprint(apiKey) : null;
      const mcpSnapshot = isCodexAgent
        ? await resolveCodexMcpSnapshot(sessionCwd)
        : { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };

      // Inject Netcatty MCP server for remote host access (scoped to this chat session)
      try {
        const mcpPort = await mcpServerBridge.getOrCreateHost();
        const scopedIds = mcpServerBridge.getScopedSessionIds(chatSessionId);
        const netcattyMcpConfig = mcpServerBridge.buildMcpServerConfig(mcpPort, scopedIds, chatSessionId);
        mcpSnapshot.mcpServers.push(netcattyMcpConfig);
      } catch (err) {
        console.error("[ACP] Failed to inject Netcatty MCP server:", err?.message || err);
      }

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

      if (!shouldReuseProvider) {
        cleanupAcpProvider(chatSessionId);

        const agentEnv = { ...shellEnv };
        if (apiKey) {
          agentEnv.CODEX_API_KEY = apiKey;
        }

        const resolvedCommand = isCodexAgent
          ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
          : acpCommand;

        const provider = createACPProvider({
          command: resolvedCommand,
          args: acpArgs || [],
          env: agentEnv,
          session: {
            cwd: sessionCwd,
            mcpServers: mcpSnapshot.mcpServers,
          },
          ...(isCodexAgent
            ? { authMethodId: apiKey ? "codex-api-key" : "chatgpt" }
            : {}),
          persistSession: true,
        });

        providerEntry = {
          provider,
          acpCommand,
          cwd: sessionCwd,
          authFingerprint,
          mcpFingerprint: mcpSnapshot.fingerprint,
          permissionMode: currentPermissionMode,
        };
        acpProviders.set(chatSessionId, providerEntry);
      }

      const abortController = new AbortController();
      acpActiveStreams.set(requestId, abortController);
      acpRequestSessions.set(requestId, chatSessionId);

      // Prepend context hint so the agent uses MCP tools for remote hosts
      const contextualPrompt =
        `[Context: You are inside Netcatty, a multi-host SSH terminal manager. ` +
        `The user is managing REMOTE servers, not the local machine. ` +
        `Use the "netcatty-remote-hosts" MCP tools to operate on the remote hosts. ` +
        `Call get_environment first to discover available hosts and their session IDs. ` +
        `For normal shell commands, use terminal_execute so you receive command output. ` +
        `Use terminal_send_input only to respond to an interactive prompt that is already running; it does not read back the updated terminal output. ` +
        `Do NOT use local shell execution.]\n\n${prompt}`;

      // Build message content: text + optional images
      function buildMessageContent(text, imgs) {
        const content = [{ type: "text", text }];
        if (Array.isArray(imgs)) {
          for (const img of imgs) {
            if (!img.base64Data || !img.mediaType) continue;
            content.push({
              type: "file",
              mediaType: img.mediaType,
              data: img.base64Data,
              ...(img.filename ? { filename: img.filename } : {}),
            });
          }
        }
        return content;
      }

      const result = streamText({
        model: providerEntry.provider.languageModel(model || undefined),
        messages: [{
          role: "user",
          content: buildMessageContent(contextualPrompt, images),
        }],
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
          resetStallTimer();
          try {
            const serialized = serializeStreamChunk(chunk);
            if (!serialized || !serialized.type) continue;

            if (serialized.type === "text-delta" || serialized.type === "reasoning-delta" || serialized.type === "tool-call") {
              hasContent = true;
            }
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
        safeSend(event.sender, "netcatty:ai:acp:error", {
          requestId,
          error: isCodexAgent
            ? "Codex returned an empty response. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key."
            : "Agent returned an empty response.",
        });
      } else {
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
    }

    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:acp:cancel", async (event, { requestId, chatSessionId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    // Cancel any active PTY executions (send Ctrl+C)
    mcpServerBridge.cancelAllPtyExecs();
    const effectiveChatSessionId = chatSessionId || acpRequestSessions.get(requestId);
    mcpServerBridge.setChatSessionCancelled?.(effectiveChatSessionId, true);
    const controller = acpActiveStreams.get(requestId);
    let cancelled = false;
    if (controller) {
      controller.abort();
      acpActiveStreams.delete(requestId);
      cancelled = true;
    }
    if (effectiveChatSessionId) {
      cleanupAcpProvider(effectiveChatSessionId);
      cancelled = true;
    }
    acpRequestSessions.delete(requestId);
    return cancelled ? { ok: true } : { ok: false, error: "Stream not found" };
  });

  // Cleanup a specific ACP session (when chat session is deleted)
  ipcMain.handle("netcatty:ai:acp:cleanup", async (event, { chatSessionId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.setChatSessionCancelled?.(chatSessionId, true);
    cleanupAcpProvider(chatSessionId);
    mcpServerBridge.cleanupScopedMetadata(chatSessionId);
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
}

module.exports = { init, registerHandlers, cleanup };
