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
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>Authorization Failed</title>
            <style>
              body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: #fff; }
              h1 { color: #ef4444; }
              p { color: #9ca3af; }
              .icon { font-size: 64px; margin-bottom: 20px; }
            </style>
          </head>
          <body>
            <div class="icon">❌</div>
            <h1>Authorization Failed</h1>
            <p>${error_description || error || "Unknown error"}</p>
            <p>You can close this window.</p>
          </body>
          </html>
        `);
        
        cleanup();
        if (pendingReject) {
          pendingReject(new Error(error_description || error || "Authorization failed"));
          pendingReject = null;
          pendingResolve = null;
        }
        return;
      }

      if (!code) {
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>Missing Code</title>
            <style>
              body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: #fff; }
              h1 { color: #ef4444; }
              p { color: #9ca3af; }
            </style>
          </head>
          <body>
            <h1>Missing Authorization Code</h1>
            <p>The authorization response did not include a code.</p>
          </body>
          </html>
        `);
        
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
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>Invalid State</title>
            <style>
              body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: #fff; }
              h1 { color: #ef4444; }
              p { color: #9ca3af; }
            </style>
          </head>
          <body>
            <h1>Security Error</h1>
            <p>State parameter mismatch. This may indicate a CSRF attack.</p>
          </body>
          </html>
        `);
        
        cleanup();
        if (pendingReject) {
          pendingReject(new Error("State mismatch - possible CSRF attack"));
          pendingReject = null;
          pendingResolve = null;
        }
        return;
      }

      // Success!
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Authorization Successful</title>
          <style>
            body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: #fff; }
            h1 { color: #22c55e; }
            p { color: #9ca3af; }
            .icon { font-size: 64px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="icon">✅</div>
          <h1>Authorization Successful!</h1>
          <p>You can close this window and return to Netcatty.</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
        </html>
      `);

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
