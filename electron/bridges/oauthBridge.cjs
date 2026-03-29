/**
 * OAuth Callback Bridge
 *
 * Handles OAuth loopback redirects for Google Drive and OneDrive.
 * Starts a temporary HTTP server on 127.0.0.1:45678 to receive authorization codes.
 */

const http = require("node:http");
const url = require("node:url");

let server = null;
let pendingResolve = null;
let pendingReject = null;
let serverTimeout = null;

const OAUTH_PORT = 45678;
const OAUTH_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderOAuthPage = ({ title, message, detail, status, autoClose }) => {
  const accent =
    status === "success" ? "200 100% 61%" : status === "error" ? "0 70% 50%" : "38 92% 50%";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = detail ? escapeHtml(detail) : "";
  const titleIcon =
    status === "success"
      ? `<svg class="title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`
      : status === "error"
        ? `<svg class="title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`
        : `<svg class="title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v20"/><path d="M5 9h14"/><path d="M7 3h10"/><path d="M7 21h10"/></svg>`;
  const detailBlock = safeDetail
    ? `<div class="detail">${safeDetail}</div>`
    : "";
  const closeScript = autoClose
    ? "<script>setTimeout(() => window.close(), 1400);</script>"
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --background: 220 28% 8%;
      --foreground: 210 40% 95%;
      --card: 220 22% 12%;
      --muted: 220 10% 70%;
      --border: 220 22% 18%;
      --accent: ${accent};
      --radius: 0.65rem;
      --ring: 200 100% 61%;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --background: 216 33% 96%;
        --foreground: 222 47% 12%;
        --card: 0 0% 100%;
        --muted: 220 10% 45%;
        --border: 220 16% 82%;
        --ring: 208 100% 50%;
      }
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif;
      background:
        radial-gradient(900px circle at 15% 0%, hsl(var(--accent) / 0.10), transparent 38%),
        radial-gradient(1200px circle at 85% 10%, hsl(var(--ring) / 0.16), transparent 40%),
        hsl(var(--background));
      color: hsl(var(--foreground));
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
    }
    .shell {
      width: min(560px, 92vw);
      border-radius: calc(var(--radius) + 10px);
      background: hsl(var(--card));
      border: 1px solid hsl(var(--border));
      box-shadow: 0 18px 40px hsl(var(--foreground) / 0.12);
      padding: 28px;
      animation: fadeUp 220ms ease-out;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 18px;
    }
    .logo {
      width: 36px;
      height: 36px;
      color: hsl(var(--accent));
    }
    .brand {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: hsl(var(--foreground));
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: -0.02em;
    }
    .title-row {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .title-icon {
      width: 22px;
      height: 22px;
      color: hsl(var(--accent));
    }
    .subtitle {
      margin: 0;
      font-size: 15px;
      line-height: 1.6;
      color: hsl(var(--muted));
    }
    .detail {
      margin-top: 16px;
      padding: 12px 14px;
      background: hsl(var(--background) / 0.6);
      border-radius: calc(var(--radius) - 4px);
      border: 1px dashed hsl(var(--border));
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
    }
    .footer {
      margin-top: 22px;
      font-size: 13px;
      color: hsl(var(--muted));
    }
    .accent {
      color: hsl(var(--accent));
      font-weight: 600;
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <svg class="logo" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <rect width="48" height="48" rx="12" fill="currentColor" fill-opacity="0.12" />
        <path
          d="M14 16C14 14.8954 14.8954 14 16 14H32C33.1046 14 34 14.8954 34 16V32C34 33.1046 33.1046 34 32 34H16C14.8954 34 14 33.1046 14 32V16Z"
          stroke="currentColor" stroke-width="2" />
        <path d="M18 22L22 26L18 30" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" />
        <path d="M26 30H30" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <div>
        <div class="brand">Netcatty</div>
      </div>
    </div>
    <h1 class="title-row"><span>${safeTitle}</span>${titleIcon}</h1>
    <p class="subtitle">${safeMessage}</p>
    ${detailBlock}
    <div class="footer">You can close this window and return to <span class="accent">Netcatty</span>.</div>
  </div>
  ${closeScript}
</body>
</html>`;
};

/**
 * Start OAuth callback server and wait for authorization code
 * @param {string} expectedState - State parameter to validate
 * @returns {Promise<{code: string, state: string}>}
 */
function startOAuthCallback(expectedState) {
  return new Promise((resolve, reject) => {
    // Clean up any existing server
    if (server) {
      try {
        server.close();
      } catch (e) {
        console.warn("Failed to close existing OAuth server:", e);
      }
    }

    pendingResolve = resolve;
    pendingReject = reject;

    server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url, true);

      // Only handle the callback path
      if (parsedUrl.pathname !== "/oauth/callback") {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>404 Not Found</h1>");
        return;
      }

      const { code, state, error, error_description } = parsedUrl.query;

      // Send response to browser
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

      if (error) {
        res.end(
          renderOAuthPage({
            title: "Authorization Failed",
            message: "We could not complete the sign-in flow.",
            detail: error_description || error || "Unknown error",
            status: "error",
          })
        );

        cleanup();
        if (pendingReject) {
          pendingReject(new Error(error_description || error || "Authorization failed"));
          pendingReject = null;
          pendingResolve = null;
        }
        return;
      }

      if (!code) {
        res.end(
          renderOAuthPage({
            title: "Missing Authorization Code",
            message: "The authorization response did not include a code.",
            status: "error",
          })
        );

        cleanup();
        if (pendingReject) {
          pendingReject(new Error("Missing authorization code"));
          pendingReject = null;
          pendingResolve = null;
        }
        return;
      }

      // Validate state if provided
      if (expectedState && state !== expectedState) {
        res.end(
          renderOAuthPage({
            title: "Security Check Failed",
            message: "State parameter mismatch. This may indicate a CSRF attack.",
            status: "error",
          })
        );

        cleanup();
        if (pendingReject) {
          pendingReject(new Error("State mismatch - possible CSRF attack"));
          pendingReject = null;
          pendingResolve = null;
        }
        return;
      }

      // Success!
      res.end(
        renderOAuthPage({
          title: "Authorization Complete",
          message: "You are signed in and ready to sync. You can close this tab now.",
          status: "success",
        })
      );

      cleanup();
      if (pendingResolve) {
        pendingResolve({ code, state });
        pendingResolve = null;
        pendingReject = null;
      }
    });

    server.on("error", (err) => {
      console.error("OAuth server error:", err);
      cleanup();
      if (pendingReject) {
        pendingReject(err);
        pendingReject = null;
        pendingResolve = null;
      }
    });

    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      console.log(`OAuth callback server listening on http://127.0.0.1:${OAUTH_PORT}`);
    });

    // Set timeout
    serverTimeout = setTimeout(() => {
      cleanup();
      if (pendingReject) {
        pendingReject(new Error("OAuth timeout - user did not complete authorization in time"));
        pendingReject = null;
        pendingResolve = null;
      }
    }, OAUTH_TIMEOUT);
  });
}

/**
 * Cancel pending OAuth flow
 */
function cancelOAuthCallback() {
  cleanup();
  if (pendingReject) {
    pendingReject(new Error("OAuth flow cancelled"));
    pendingReject = null;
    pendingResolve = null;
  }
}

/**
 * Clean up server and timeout
 */
function cleanup() {
  if (serverTimeout) {
    clearTimeout(serverTimeout);
    serverTimeout = null;
  }
  if (server) {
    try {
      server.close();
    } catch (e) {
      // Ignore
    }
    server = null;
  }
}

/**
 * Setup IPC handlers
 * @param {Electron.IpcMain} ipcMain
 */
function setupOAuthBridge(ipcMain) {
  ipcMain.handle("oauth:startCallback", async (_event, expectedState) => {
    return startOAuthCallback(expectedState);
  });

  ipcMain.handle("oauth:cancelCallback", async () => {
    cancelOAuthCallback();
  });
}

module.exports = {
  setupOAuthBridge,
  startOAuthCallback,
  cancelOAuthCallback,
};
