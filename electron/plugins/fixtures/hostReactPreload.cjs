"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const listen = (channel, callback) => { const handler = (_event, value) => callback(value); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld("netcatty", {
  getPluginRuntimeStatus: () => ipcRenderer.invoke("netcatty:plugins:status"),
  getPluginContributions: (query) => ipcRenderer.invoke("netcatty:plugins:contributions", query),
  updatePluginSetting: (pluginId, settingId, value, scopeId) => ipcRenderer.invoke("netcatty:plugins:update-setting", { pluginId, settingId, value, scopeId }),
  resetPluginSetting: (pluginId, settingId, scopeId) => ipcRenderer.invoke("netcatty:plugins:reset-setting", { pluginId, settingId, scopeId }),
  onPluginContributionsChanged: (callback) => listen("netcatty:plugins:contributions-changed", callback),
  getPluginViewResource: (payload) => ipcRenderer.invoke("netcatty:plugins:host-ui-resource", payload),
  openHostDrawnPluginView: (payload) => ipcRenderer.invoke("netcatty:plugins:host-ui-open", payload),
  closeHostDrawnPluginView: (instanceId) => ipcRenderer.invoke("netcatty:plugins:host-ui-close", { instanceId }),
  sendHostDrawnPluginViewEvent: (instanceId, event) => ipcRenderer.invoke("netcatty:plugins:host-ui-event", { instanceId, event }),
  onHostDrawnPluginViewUpdate: (callback) => listen("netcatty:plugins:host-ui-update", callback),
  onPluginViewClosed: (callback) => listen("netcatty:plugins:view-closed", callback),
});
