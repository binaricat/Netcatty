"use strict";

/**
 * MCP tools/call `arguments` is optional. Clients may omit it for no-arg
 * tools or send {}. The SDK still parses omitted args as `undefined`, and
 * Zod object schemas reject that. Treat missing/null as {}.
 */

function normalizeMcpToolArguments(args) {
  return args == null ? {} : args;
}

function normalizeMcpJsonRpcMessage(message) {
  if (!message || typeof message !== "object") return message;
  if (message.method !== "tools/call") return message;
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return message;
  if (params.arguments == null) {
    params.arguments = {};
  }
  return message;
}

module.exports = {
  normalizeMcpToolArguments,
  normalizeMcpJsonRpcMessage,
};
