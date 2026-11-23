"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const listen = (channel, callback) => { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
contextBridge.exposeInMainWorld("fixture", { configuration: () => ipcRenderer.invoke("fixture:configuration") });
contextBridge.exposeInMainWorld("netcatty", {
  startPortForward: () => { throw new Error("Fixture forbids opening a local port forwarding listener"); },
  setPluginInteractionReady: (ready) => ipcRenderer.invoke("netcatty:plugins:interaction-ready", { ready }),
  respondPluginInteraction: (response) => ipcRenderer.invoke("netcatty:plugins:interaction-response", response),
  openPluginHostStream: (payload) => ipcRenderer.invoke("netcatty:plugins:host-stream-open", payload),
  onPluginInteraction: (callback) => listen("netcatty:plugins:host-interaction", callback),
  getPluginRuntimeStatus: () => ipcRenderer.invoke("netcatty:plugins:status"),
  getPluginContributions: (query) => ipcRenderer.invoke("netcatty:plugins:contributions", query),
  onPluginContributionsChanged: (callback) => listen("netcatty:plugins:contributions-changed", callback),
  getPluginViewResource: (payload) => ipcRenderer.invoke("netcatty:plugins:host-ui-resource", payload),
  openHostDrawnPluginView: (payload) => ipcRenderer.invoke("netcatty:plugins:host-ui-open", payload),
  closeHostDrawnPluginView: (instanceId) => ipcRenderer.invoke("netcatty:plugins:host-ui-close", { instanceId }),
  sendHostDrawnPluginViewEvent: (instanceId, event) => ipcRenderer.invoke("netcatty:plugins:host-ui-event", { instanceId, event }),
  onHostDrawnPluginViewUpdate: (callback) => listen("netcatty:plugins:host-ui-update", callback),
  onPluginViewClosed: (callback) => listen("netcatty:plugins:view-closed", callback),
});
