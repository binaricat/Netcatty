"use strict";

function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
  ipcMain.handle(channel, (event, payload) => terminalWorkerManager.request(channel, payload, {
    webContentsId: event?.sender?.id,
  }));
}

module.exports = {
  registerWorkerHandle,
};
