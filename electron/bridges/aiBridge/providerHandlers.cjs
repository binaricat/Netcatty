/* eslint-disable no-undef */
function registerProviderHandlers(ctx) {
  with (ctx) {
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

  }
}

module.exports = { registerProviderHandlers };
