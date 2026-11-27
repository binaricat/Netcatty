"use strict";

let _defaultPrivacyService = null;
function getDefaultPrivacyService() {
  if (!_defaultPrivacyService) {
    _defaultPrivacyService = require("../../shared/aiPrivacyService.cjs");
  }
  return _defaultPrivacyService;
}

function registerPrivacyHandlers({ ipcMain, validateSender, aiPrivacyService }) {
  const resolveService = () => aiPrivacyService || getDefaultPrivacyService();
  ipcMain.handle("netcatty:ai:privacy:status", (event) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized" };
    try {
      return { ok: true, enabled: resolveService().isEnabled() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("netcatty:ai:privacy:transform", (event, request = {}) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized" };
    try {
      if (request.operation !== "redact" && request.operation !== "restore") {
        throw new Error("Invalid AI privacy operation.");
      }
      return {
        ok: true,
        value: resolveService()[request.operation](request.chatSessionId, request.value),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("netcatty:ai:privacy:clear", (event, chatSessionId) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized" };
    resolveService().clearSession(chatSessionId);
    return { ok: true };
  });
}

module.exports = { registerPrivacyHandlers };
