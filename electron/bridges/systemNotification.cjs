"use strict";

const TITLE_MAX = 120;
const BODY_MAX = 500;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeNotificationText(value, max) {
  if (typeof value !== "string" || max <= 0) return "";
  const cleaned = value.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function showSystemNotification({
  Notification,
  BrowserWindow,
  sender,
  title,
  body,
  sessionId,
  defaultTitle = "Netcatty",
}) {
  if (typeof Notification !== "function" || typeof Notification.isSupported !== "function") {
    return { shown: false, reason: "unavailable" };
  }
  if (!Notification.isSupported()) {
    return { shown: false, reason: "unsupported" };
  }

  const safeTitle = sanitizeNotificationText(title, TITLE_MAX) || defaultTitle;
  const safeBody = sanitizeNotificationText(body, BODY_MAX);
  const safeSessionId = typeof sessionId === "string" ? sessionId : "";

  const notification = new Notification({
    title: safeTitle,
    body: safeBody,
    silent: false,
  });

  notification.on("click", () => {
    const win = typeof BrowserWindow?.fromWebContents === "function"
      ? BrowserWindow.fromWebContents(sender)
      : null;
    if (win && !win.isDestroyed()) {
      if (typeof win.isMinimized === "function" && win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (safeSessionId && sender && typeof sender.isDestroyed === "function" && !sender.isDestroyed()) {
      sender.send("netcatty:tray:focusSession", safeSessionId);
    }
  });

  notification.show();
  return { shown: true };
}

function registerSystemNotificationHandlers(ipcMain, { electronModule, BrowserWindow }) {
  ipcMain.handle("netcatty:notification:show", async (event, payload) => {
    try {
      return showSystemNotification({
        Notification: electronModule?.Notification,
        BrowserWindow,
        sender: event?.sender,
        title: payload?.title,
        body: payload?.body,
        sessionId: payload?.sessionId,
      });
    } catch (err) {
      return { shown: false, reason: err?.message || "failed" };
    }
  });
}

module.exports = {
  sanitizeNotificationText,
  showSystemNotification,
  registerSystemNotificationHandlers,
};
