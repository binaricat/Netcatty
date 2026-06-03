const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerHandlers,
  ONEDRIVE_REAUTH_REQUIRED_MARKER,
} = require("./onedriveAuthBridge.cjs");

function createIpcMainStub() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

function makeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function registerWithFetch(fetchImpl) {
  const ipcMain = createIpcMainStub();
  registerHandlers(ipcMain, { net: { fetch: fetchImpl } });
  return ipcMain;
}

test("onedrive refresh tags invalid_grant with the reauth marker", async () => {
  const ipcMain = registerWithFetch(async () =>
    makeJsonResponse(400, {
      error: "invalid_grant",
      error_description: "AADSTS70000: refresh token expired",
    })
  );
  const refresh = ipcMain.handlers.get("netcatty:onedrive:oauth:refresh");
  assert.ok(refresh, "refresh handler registered");

  await assert.rejects(
    () => refresh({}, { clientId: "client", refreshToken: "stale-refresh" }),
    (err) => {
      assert.ok(
        err.message.includes(ONEDRIVE_REAUTH_REQUIRED_MARKER),
        `expected marker in message, got: ${err.message}`
      );
      assert.match(err.message, /AADSTS70000/);
      return true;
    }
  );
});

test("onedrive refresh does NOT tag generic failures with the reauth marker", async () => {
  const ipcMain = registerWithFetch(async () =>
    makeJsonResponse(500, { error: "temporarily_unavailable" })
  );
  const refresh = ipcMain.handlers.get("netcatty:onedrive:oauth:refresh");

  await assert.rejects(
    () => refresh({}, { clientId: "client", refreshToken: "ok-refresh" }),
    (err) => {
      assert.ok(
        !err.message.includes(ONEDRIVE_REAUTH_REQUIRED_MARKER),
        `did not expect marker, got: ${err.message}`
      );
      assert.match(err.message, /OneDrive token refresh failed/);
      return true;
    }
  );
});

test("onedrive refresh returns the rotated refresh token from the response", async () => {
  const ipcMain = registerWithFetch(async () =>
    makeJsonResponse(200, {
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "scope",
    })
  );
  const refresh = ipcMain.handlers.get("netcatty:onedrive:oauth:refresh");

  const tokens = await refresh({}, { clientId: "client", refreshToken: "old-refresh" });
  assert.equal(tokens.accessToken, "new-access");
  assert.equal(tokens.refreshToken, "rotated-refresh");
  assert.equal(tokens.tokenType, "Bearer");
  assert.ok(tokens.expiresAt > Date.now());
});

test("onedrive refresh falls back to the supplied refresh token when none is returned", async () => {
  const ipcMain = registerWithFetch(async () =>
    makeJsonResponse(200, {
      access_token: "new-access",
      expires_in: 3600,
      token_type: "Bearer",
    })
  );
  const refresh = ipcMain.handlers.get("netcatty:onedrive:oauth:refresh");

  const tokens = await refresh({}, { clientId: "client", refreshToken: "kept-refresh" });
  assert.equal(tokens.refreshToken, "kept-refresh");
});
