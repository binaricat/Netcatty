"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostBrowser", Object.freeze({
  snapshot: () => ipcRenderer.invoke("netcatty:host-browser:snapshot"),
  command: (command) => ipcRenderer.invoke("netcatty:host-browser:command", command),
  listBookmarks: () => ipcRenderer.invoke("netcatty:host-browser:bookmarks:list"),
  saveBookmark: (bookmark) => ipcRenderer.invoke("netcatty:host-browser:bookmarks:upsert", bookmark),
  removeBookmark: (id) => ipcRenderer.invoke("netcatty:host-browser:bookmarks:remove", id),
  listDownloads: () => ipcRenderer.invoke("netcatty:host-browser:downloads:list"),
  onDownloadsChanged: (callback) => {
    const listener = (_event, downloads) => callback(downloads);
    ipcRenderer.on("netcatty:host-browser:downloads-changed", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:downloads-changed", listener);
  },
  onBookmarksChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("netcatty:host-browser:bookmarks-changed", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:bookmarks-changed", listener);
  },
  onSiteIconsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("netcatty:host-browser:site-icons-changed", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:site-icons-changed", listener);
  },
  onShortcut: (callback) => {
    const listener = (_event, shortcut) => callback(shortcut);
    ipcRenderer.on("netcatty:host-browser:shortcut", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:shortcut", listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("netcatty:host-browser:state", listener);
    return () => ipcRenderer.removeListener("netcatty:host-browser:state", listener);
  },
}));
