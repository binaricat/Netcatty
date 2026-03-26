/**
 * Shared IPC utilities for bridge modules.
 */

/**
 * Safely send an IPC message to a renderer, guarding against destroyed senders.
 * @param {Electron.WebContents} sender
 * @param {string} channel
 * @param {...unknown} args
 */
function safeSend(sender, channel, ...args) {
  try {
    if (!sender || sender.isDestroyed()) return;
    sender.send(channel, ...args);
  } catch {
    // Ignore destroyed webContents during shutdown / HMR reload.
  }
}

module.exports = { safeSend };
