"use strict";

/**
 * Vendor assistant IPC surface.
 *
 * Exposes the browser-driven "ask the vendor's official AI assistant" flow to
 * the renderer. Questions run one at a time: each call owns a browser process,
 * and overlapping calls would fight over the persistent profile (see service.cjs,
 * which the external MCP surface shares).
 *
 * The settings page lives in its own BrowserWindow, so these channels use the
 * settings-aware guard; the strict main-window guard rejects it as Unauthorized.
 */

const { askVendor, listVendors, openVendorLogin } = require("./vendorAssistant/service.cjs");

function resolveGuard({ validateSenderOrSettings, validateSender }) {
  return validateSenderOrSettings || validateSender || (() => false);
}

function registerVendorAssistantHandlers({ ipcMain, validateSenderOrSettings, validateSender }) {
  const isAllowed = resolveGuard({ validateSenderOrSettings, validateSender });

  ipcMain.handle("netcatty:ai:vendor:status", (event) => {
    if (!isAllowed(event)) return { ok: false, error: "Unauthorized" };
    return listVendors();
  });

  ipcMain.handle("netcatty:ai:vendor:ask", async (event, request = {}) => {
    if (!isAllowed(event)) return { ok: false, error: "Unauthorized" };
    return askVendor(request);
  });

  ipcMain.handle("netcatty:ai:vendor:login", async (event, request = {}) => {
    if (!isAllowed(event)) return { ok: false, error: "Unauthorized" };
    return openVendorLogin(request);
  });
}

module.exports = { registerVendorAssistantHandlers };
