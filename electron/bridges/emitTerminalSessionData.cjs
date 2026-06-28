"use strict";

const { trackEmitted } = require("./terminalFlowAck.cjs");

let getSession = null;
let outputChannel = null;
/** @type {Set<(sessionId: string, data: string) => void>} */
const dataTaps = new Set();

function configureTerminalSessionDataEmitter(options = {}) {
  getSession = typeof options.getSession === "function" ? options.getSession : null;
  outputChannel = options.outputChannel || null;
}

function addTerminalDataTap(listener) {
  if (typeof listener !== "function") return () => {};
  dataTaps.add(listener);
  return () => dataTaps.delete(listener);
}

function emitTerminalSessionData(contents, sessionId, data) {
  if (getSession && sessionId && data) {
    const session = getSession(sessionId);
    if (session) {
      trackEmitted(session, typeof data === "string" ? data.length : 0);
    }
  }
  if (sessionId && data) {
    for (const tap of dataTaps) {
      try {
        tap(sessionId, data);
      } catch (err) {
        console.warn("[emitTerminalSessionData] tap failed", err);
      }
    }
  }
  if (outputChannel?.send?.(sessionId, data)) return;
  contents?.send("netcatty:data", { sessionId, data });
}

module.exports = {
  configureTerminalSessionDataEmitter,
  emitTerminalSessionData,
  addTerminalDataTap,
};
