"use strict";

const { randomBytes } = require("node:crypto");
const PREFIX = "plugin-agent:";
const { listMcpTools } = require("../../capabilities/codegen/toolSurfaces.cjs");
const toolsByMethod = new Map(listMcpTools().map((tool) => [tool.rpcMethod, tool.mcpTool]));

// Main-only per-turn MCP credentials. A managed Agent subprocess receives this
// credential instead of the app-wide token; no token crosses the plugin API.
class PluginAgentMcpDelegations {
  constructor() {
    this.sessions = new Map();
    this.tokens = new Map();
    this.sockets = new WeakMap();
    this.approvedContexts = new WeakSet();
  }

  register(chatSessionId, { dispatch, assertCurrent, senderId, tools, turnTag }) {
    if (typeof chatSessionId !== "string" || !chatSessionId.startsWith(PREFIX)
      || typeof dispatch !== "function" || typeof assertCurrent !== "function"
      || typeof turnTag !== "string" || !/^[0-9a-f-]{36}$/u.test(turnTag)
      || !Number.isSafeInteger(senderId) || !Array.isArray(tools) || tools.length > 128
      || tools.some((tool) => typeof tool !== "string" || !tool || tool.length > 128)
      || this.sessions.has(chatSessionId) || this.sessions.size >= 64) throw Error("Invalid Agent delegation");
    const token = randomBytes(32).toString("hex");
    const entry = { chatSessionId, turnTag, token, dispatch, assertCurrent, senderId, modelRequests: 0, tools: Object.freeze([...tools]), sockets: new Set(), cancellations: new Set() };
    this.sessions.set(chatSessionId, entry); this.tokens.set(token, entry);
    return Object.freeze({ dispose: () => { if (this.sessions.get(chatSessionId) === entry) this.release(chatSessionId); } });
  }

  #assert(entry) {
    if (!entry || this.sessions.get(entry.chatSessionId) !== entry) throw Error("Agent delegation unavailable");
    try { entry.assertCurrent(); }
    catch (error) {
      // This callback is a synchronous main-owned authority check, not an RPC
      // signal. Discovering revocation must abort already-running native work.
      if (this.sessions.get(entry.chatSessionId) === entry) this.release(entry.chatSessionId);
      throw error;
    }
    return entry;
  }

  authenticate(token, socket) {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    try { this.#assert(entry); } catch { return false; }
    this.sockets.set(socket, entry); entry.sockets.add(socket);
    socket.once?.("close", () => entry.sockets.delete(socket));
    return true;
  }

  boundChat(socket) {
    const entry = this.sockets.get(socket);
    return entry ? this.#assert(entry).chatSessionId : null;
  }

  configuration(chatSessionId, turnTag) {
    const entry = this.#assert(this.sessions.get(chatSessionId));
    if (entry.turnTag !== turnTag) throw Error("Agent turn unavailable");
    return Object.freeze({ token: entry.token, tools: entry.tools });
  }

  has(chatSessionId) { return this.sessions.has(chatSessionId); }
  assertCaller(chatSessionId, senderId, turnTag) {
    const entry = this.#assert(this.sessions.get(chatSessionId));
    if (entry.senderId !== senderId || entry.turnTag !== turnTag) throw Error("Agent caller unavailable");
  }
  onRelease(chatSessionId, turnTag, cancel) {
    const entry = this.#assert(this.sessions.get(chatSessionId));
    if (entry.turnTag !== turnTag) throw Error("Agent turn unavailable");
    if (typeof cancel !== "function") throw Error("Native cancellation callback required");
    entry.cancellations.add(cancel);
    return () => entry.cancellations.delete(cancel);
  }
  beginModelRequest(chatSessionId, senderId, turnTag) {
    this.assertCaller(chatSessionId, senderId, turnTag);
    const entry = this.sessions.get(chatSessionId);
    if (++entry.modelRequests > 32) { this.release(chatSessionId); throw Error("Agent model request budget exceeded"); }
  }
  isReserved(chatSessionId) { return typeof chatSessionId === "string" && chatSessionId.startsWith(PREFIX); }
  isApproved(context) { return this.approvedContexts.has(context); }

  async dispatch(method, params, context, execute) {
    const entry = this.#assert(this.sessions.get(params.chatSessionId));
    if (!entry.tools.includes(toolsByMethod.get(method))) throw Error("Tool is outside the Agent delegation");
    const socketEntry = context.externalSocket && this.sockets.get(context.externalSocket);
    if (socketEntry !== entry && (context.trustedAgentSenderId !== entry.senderId || context.trustedAgentTurnTag !== entry.turnTag)) throw Error("Agent caller unavailable");
    if (socketEntry && socketEntry !== entry) throw Error("Agent connection cannot change its session");
    return entry.dispatch(method, params, async () => {
      this.#assert(entry);
      const approved = { ...context, beforeExecute: () => {
        this.#assert(entry); context.beforeExecute?.();
      } };
      this.approvedContexts.add(approved);
      try { return await execute(approved); }
      finally { this.approvedContexts.delete(approved); }
    });
  }

  release(chatSessionId) {
    const entry = this.sessions.get(chatSessionId);
    if (!entry) return;
    this.sessions.delete(chatSessionId); this.tokens.delete(entry.token);
    for (const cancel of entry.cancellations) { try { cancel(); } catch {} }
    entry.cancellations.clear();
    for (const socket of entry.sockets) { try { socket.destroy(); } catch {} }
    entry.sockets.clear();
  }

  shutdown() { for (const id of this.sessions.keys()) this.release(id); }
}

module.exports = { PluginAgentMcpDelegations };
