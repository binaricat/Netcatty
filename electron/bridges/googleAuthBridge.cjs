/**
 * Google OAuth Bridge (main process)
 *
 * Renderer fetches to Google's OAuth token endpoint can be blocked by CORS.
 * This bridge proxies Google token exchange/refresh and userinfo via the main process.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DEFAULT_SYNC_FILE_NAME = "netcatty-vault.json";
const { randomUUID } = require("node:crypto");

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

const describeNetworkError = (err) => {
  const msg = err?.message || String(err);
  const cause = err?.cause;
  const causeCode = cause?.code ? ` (${cause.code})` : "";
  const causeMsg = cause?.message ? `: ${cause.message}` : "";
  return `${msg}${causeCode}${causeMsg}`.trim();
};

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const describeGoogleApiError = (status, text) => {
  const data = safeJsonParse(text);
  const msg =
    data?.error?.message ||
    data?.error_description ||
    data?.error ||
    (typeof text === "string" && text.trim().length ? text.trim() : "Unknown error");
  return `${status} - ${String(msg).slice(0, 300)}`;
};

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {import('electron')=} electronModule
 */
function registerHandlers(ipcMain, electronModule) {
  const fetchImpl =
    electronModule?.net?.fetch ? electronModule.net.fetch.bind(electronModule.net) : fetch;

  ipcMain.handle("netcatty:google:oauth:exchange", async (_event, payload) => {
    const clientId = payload?.clientId;
    const clientSecret = payload?.clientSecret;
    const code = payload?.code;
    const codeVerifier = payload?.codeVerifier;
    const redirectUri = payload?.redirectUri;

    if (!isNonEmptyString(clientId)) throw new Error("Missing Google clientId");
    if (!isNonEmptyString(code)) throw new Error("Missing authorization code");
    if (!isNonEmptyString(codeVerifier)) throw new Error("Missing codeVerifier");
    if (!isNonEmptyString(redirectUri)) throw new Error("Missing redirectUri");

    const body = new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    if (isNonEmptyString(clientSecret)) {
      body.set("client_secret", clientSecret);
    }

    let res;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new Error(
        `Google token exchange network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
      throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Google token exchange invalid JSON: ${text.slice(0, 200)}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 0) * 1000,
      tokenType: data.token_type,
      scope: data.scope,
    };
  });

  ipcMain.handle("netcatty:google:oauth:refresh", async (_event, payload) => {
    const clientId = payload?.clientId;
    const clientSecret = payload?.clientSecret;
    const refreshToken = payload?.refreshToken;

    if (!isNonEmptyString(clientId)) throw new Error("Missing Google clientId");
    if (!isNonEmptyString(refreshToken)) throw new Error("Missing refreshToken");

    const body = new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (isNonEmptyString(clientSecret)) {
      body.set("client_secret", clientSecret);
    }

    let res;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new Error(
        `Google token refresh network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
      throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Google token refresh invalid JSON: ${text.slice(0, 200)}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + (data.expires_in || 0) * 1000,
      tokenType: data.token_type,
      scope: data.scope,
    };
  });

  ipcMain.handle("netcatty:google:oauth:userinfo", async (_event, payload) => {
    const accessToken = payload?.accessToken;
    if (!isNonEmptyString(accessToken)) throw new Error("Missing accessToken");

    let res;
    try {
      res = await fetchImpl(GOOGLE_USERINFO_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch (err) {
      throw new Error(
        `Google userinfo network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Google userinfo failed: ${res.status} - ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Google userinfo invalid JSON: ${text.slice(0, 200)}`);
    }
  });

  // Google Drive API (appDataFolder) - proxied to avoid CORS/COEP issues in renderer
  ipcMain.handle("netcatty:google:drive:findSyncFile", async (_event, payload) => {
    const accessToken = payload?.accessToken;
    const fileName = isNonEmptyString(payload?.fileName) ? payload.fileName : DEFAULT_SYNC_FILE_NAME;
    if (!isNonEmptyString(accessToken)) throw new Error("Missing accessToken");

    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name = '${fileName}'`,
      fields: "files(id, name, modifiedTime)",
    });

    let res;
    try {
      res = await fetchImpl(`${GOOGLE_DRIVE_API}/files?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new Error(
        `Google Drive network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error("Google Drive API not enabled. Please enable it in Google Cloud Console.");
      }
      if (res.status === 401) {
        throw new Error("Token expired or invalid. Please reconnect Google Drive.");
      }
      throw new Error(`Google Drive API error: ${describeGoogleApiError(res.status, text)}`);
    }

    const data = safeJsonParse(text);
    const fileId = data?.files?.[0]?.id || null;
    return { fileId };
  });

  ipcMain.handle("netcatty:google:drive:createSyncFile", async (_event, payload) => {
    const accessToken = payload?.accessToken;
    const fileName = isNonEmptyString(payload?.fileName) ? payload.fileName : DEFAULT_SYNC_FILE_NAME;
    const syncedFile = payload?.syncedFile;
    if (!isNonEmptyString(accessToken)) throw new Error("Missing accessToken");
    if (!syncedFile) throw new Error("Missing syncedFile");

    const boundary = `----netcatty_${randomUUID()}`;
    const metadata = JSON.stringify({
      name: fileName,
      parents: ["appDataFolder"],
    });
    const content = JSON.stringify(syncedFile, null, 2);

    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${content}\r\n` +
      `--${boundary}--\r\n`;

    let res;
    try {
      res = await fetchImpl(`${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      });
    } catch (err) {
      throw new Error(
        `Google Drive upload network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error("Google Drive API not enabled. Please enable it in Google Cloud Console.");
      }
      if (res.status === 401) {
        throw new Error("Token expired or invalid. Please reconnect Google Drive.");
      }
      throw new Error(`Google Drive upload error: ${describeGoogleApiError(res.status, text)}`);
    }

    const data = safeJsonParse(text);
    const fileId = data?.id;
    if (!isNonEmptyString(fileId)) {
      throw new Error(`Google Drive upload invalid response: ${text.slice(0, 200)}`);
    }

    return { fileId };
  });

  ipcMain.handle("netcatty:google:drive:updateSyncFile", async (_event, payload) => {
    const accessToken = payload?.accessToken;
    const fileId = payload?.fileId;
    const syncedFile = payload?.syncedFile;
    if (!isNonEmptyString(accessToken)) throw new Error("Missing accessToken");
    if (!isNonEmptyString(fileId)) throw new Error("Missing fileId");
    if (!syncedFile) throw new Error("Missing syncedFile");

    let res;
    try {
      res = await fetchImpl(`${GOOGLE_DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(syncedFile, null, 2),
      });
    } catch (err) {
      throw new Error(
        `Google Drive update network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error("Google Drive API not enabled. Please enable it in Google Cloud Console.");
      }
      if (res.status === 401) {
        throw new Error("Token expired or invalid. Please reconnect Google Drive.");
      }
      throw new Error(`Google Drive update error: ${describeGoogleApiError(res.status, text)}`);
    }

    return { ok: true };
  });

  ipcMain.handle("netcatty:google:drive:downloadSyncFile", async (_event, payload) => {
    const accessToken = payload?.accessToken;
    const fileId = payload?.fileId;
    if (!isNonEmptyString(accessToken)) throw new Error("Missing accessToken");
    if (!isNonEmptyString(fileId)) throw new Error("Missing fileId");

    let res;
    try {
      res = await fetchImpl(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new Error(
        `Google Drive download network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404) return { syncedFile: null };
      if (res.status === 401) {
        throw new Error("Token expired or invalid. Please reconnect Google Drive.");
      }
      throw new Error(`Google Drive download error: ${describeGoogleApiError(res.status, text)}`);
    }

    const data = safeJsonParse(text);
    if (!data) {
      throw new Error(`Google Drive download invalid JSON: ${text.slice(0, 200)}`);
    }

    return { syncedFile: data };
  });

  ipcMain.handle("netcatty:google:drive:deleteSyncFile", async (_event, payload) => {
    const accessToken = payload?.accessToken;
    const fileId = payload?.fileId;
    if (!isNonEmptyString(accessToken)) throw new Error("Missing accessToken");
    if (!isNonEmptyString(fileId)) throw new Error("Missing fileId");

    let res;
    try {
      res = await fetchImpl(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new Error(
        `Google Drive delete network error. Check your network/VPN and whether Google services are reachable. (${describeNetworkError(err)})`
      );
    }

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error("Token expired or invalid. Please reconnect Google Drive.");
      }
      throw new Error(`Google Drive delete error: ${describeGoogleApiError(res.status, text)}`);
    }

    return { ok: true };
  });
}

module.exports = { registerHandlers };
