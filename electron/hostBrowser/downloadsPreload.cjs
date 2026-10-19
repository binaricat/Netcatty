"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostBrowserDownloads", Object.freeze({
  list: () => ipcRenderer.invoke("netcatty:host-browser:downloads:list"),
  theme: () => ipcRenderer.invoke("netcatty:host-browser:downloads:theme"),
  command: (type, id) => ipcRenderer.invoke("netcatty:host-browser:downloads:command", { type, id }),
  onChanged: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on("netcatty:host-browser:downloads-changed", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:downloads-changed", listener);
  },
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on("netcatty:host-browser:theme", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:theme", listener);
  },
}));
