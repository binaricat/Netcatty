"use strict";

const { z } = require("zod");
const { listMcpTools } = require("./toolSurfaces.cjs");

const TERMINAL_EXECUTE_TOOLS = new Set(["terminal_execute"]);
const TERMINAL_START_TOOLS = new Set(["terminal_start"]);
const TERMINAL_POLL_TOOLS = new Set(["terminal_poll"]);
const TERMINAL_STOP_TOOLS = new Set(["terminal_stop"]);
const SESSION_CLOSE_TOOLS = new Set(["session_close"]);
const CONTEXT_TOOLS = new Set(["get_environment"]);
const ATTACHMENT_LIST_TOOLS = new Set(["list_attachments"]);
const ATTACHMENT_READ_TOOLS = new Set(["read_attachment"]);
const SFTP_WRITE_TOOLS = new Set([
  "sftp_write_file",
  "sftp_mkdir",
  "sftp_delete",
  "sftp_rename",
  "sftp_chmod",
]);

function buildZodField(field) {
  let schema = field.type === "number" ? z.number() : z.string();
  if (field.type === "number") {
    schema = schema.int().min(0);
  }
  if (field.description) {
    schema = schema.describe(field.description);
  }
  if (field.optional) {
    schema = schema.optional();
  }
  return schema;
}

function buildZodShapeObject(inputShape) {
  const shape = {};
  for (const [key, field] of Object.entries(inputShape || {})) {
    shape[key] = buildZodField(field);
  }
  return shape;
}

function buildZodSchema(inputShape) {
  return z.object(buildZodShapeObject(inputShape));
}

function isEmptyMcpInputShape(inputShape) {
  return Object.keys(inputShape || {}).length === 0;
}

function formatRpcError(result) {
  if (result?.error) return `Error: ${result.error}`;
  if (result?.code) return `Error: Operation failed (${result.code})`;
  return "Error: Operation failed";
}

/**
 * True when the RPC result carries command-run evidence (output and/or exit
 * code). Non-zero exits from PTY exec set ok:false without an error string —
 * that is still a completed command, not an operational failure.
 */
function hasTerminalExecuteEvidence(result) {
  if (!result || typeof result !== "object") return false;
  if (typeof result.stdout === "string" && result.stdout.length > 0) return true;
  if (typeof result.stderr === "string" && result.stderr.length > 0) return true;
  return result.exitCode != null;
}

function formatTerminalExecuteResult(result) {
  const parts = [];
  if (result?.stdout) parts.push(result.stdout);
  if (result?.stderr) parts.push(`[stderr] ${result.stderr}`);
  if (result?.exitCode != null) {
    parts.push(`[exit code: ${result.exitCode}]`);
  }
  if (result?.error) parts.push(`[error] ${result.error}`);
  return parts.join("\n");
}

// Align with Catty executor wording when a command ran but produced no text.
const TERMINAL_EXECUTE_NO_OUTPUT_TEXT = "Command completed (no output)";

/**
 * Format terminal_execute for MCP clients.
 * Match Catty semantics: when the command actually ran, always surface
 * stdout/stderr/exitCode so the model can judge the failure. Only pure
 * operational failures (session missing, blocked, etc.) become a bare
 * "Error: …" payload. See issue #2718.
 *
 * Successful empty results (serial/network raw PTY often returns ok:true with
 * empty stdout/stderr and exitCode:null) must NOT fall back to
 * "Error: Operation failed" — Codex P2 on PR #2724.
 */
function formatTerminalExecuteMcpResponse(result) {
  if (!result || typeof result !== "object") {
    return { content: [{ type: "text", text: formatRpcError(result) }], isError: true };
  }

  // Operational failure with no command evidence (session not found, busy, blocked…).
  if (result.ok === false && !hasTerminalExecuteEvidence(result)) {
    return { content: [{ type: "text", text: formatRpcError(result) }], isError: true };
  }

  // Empty successful payloads (serial/raw PTY): neutral text.
  // Never fall back to formatRpcError here — that mislabels silent successes (#2724 P2).
  // When result.error is set, formatTerminalExecuteResult already includes `[error] …`.
  const text = formatTerminalExecuteResult(result) || TERMINAL_EXECUTE_NO_OUTPUT_TEXT;
  // Mark isError only for operational/runtime failures that include an error
  // string (timeout, cancel, stream lost). Non-zero exit alone is success of
  // the tool call with a failed command — same as Catty ok:true + exitCode.
  if (result.ok === false && result.error) {
    return { content: [{ type: "text", text }], isError: true };
  }
  return { content: [{ type: "text", text }] };
}

function createToolHandler(toolDef, deps) {
  const {
    rpcCall,
    scopeParams,
    guardWriteOperation,
    catalogDescription,
  } = deps;
  const { mcpTool, rpcMethod, description, inputShape, policy } = toolDef;

  return async (args) => {
    if (TERMINAL_EXECUTE_TOOLS.has(mcpTool) || TERMINAL_START_TOOLS.has(mcpTool)) {
      const { sessionId, command } = args;
      const guardErr = guardWriteOperation(command, { skipBlocklist: true });
      if (guardErr) {
        return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
      }
      const result = await rpcCall(rpcMethod, { ...scopeParams, sessionId, command });
      if (TERMINAL_START_TOOLS.has(mcpTool)) {
        if (!result?.ok) {
          return { content: [{ type: "text", text: formatRpcError(result) }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              jobId: result.jobId,
              sessionId: result.sessionId,
              status: result.status,
              startedAt: result.startedAt,
              outputMode: result.outputMode,
              recommendedPollIntervalMs: result.recommendedPollIntervalMs,
            }, null, 2),
          }],
        };
      }
      return formatTerminalExecuteMcpResponse(result);
    }

    if (TERMINAL_POLL_TOOLS.has(mcpTool) || TERMINAL_STOP_TOOLS.has(mcpTool)) {
      const params = TERMINAL_POLL_TOOLS.has(mcpTool)
        ? { ...scopeParams, jobId: args.jobId, offset: args.offset || 0 }
        : { ...scopeParams, jobId: args.jobId };
      const result = await rpcCall(rpcMethod, params);
      if (!result.ok) {
        return { content: [{ type: "text", text: formatRpcError(result) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (SESSION_CLOSE_TOOLS.has(mcpTool)) {
      const result = await rpcCall(rpcMethod, { ...scopeParams, sessionId: args.sessionId });
      if (!result.ok) {
        return { content: [{ type: "text", text: formatRpcError(result) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (CONTEXT_TOOLS.has(mcpTool)) {
      const ctx = await rpcCall(rpcMethod, scopeParams);
      return { content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }] };
    }

    if (ATTACHMENT_LIST_TOOLS.has(mcpTool)) {
      const result = await rpcCall(rpcMethod, scopeParams);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: formatRpcError(result) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.attachments || [], null, 2) }],
      };
    }

    if (ATTACHMENT_READ_TOOLS.has(mcpTool)) {
      const { filePath, filename } = args;
      const result = await rpcCall(rpcMethod, { ...scopeParams, filePath, filename });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: formatRpcError(result) }],
          isError: true,
        };
      }
      const payload = {
        filename: result.filename,
        mediaType: result.mediaType,
        filePath: result.filePath,
        sizeBytes: result.sizeBytes,
        ...(result.text != null ? { text: result.text } : { base64Data: result.base64Data }),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (policy?.write) {
      const guardErr = guardWriteOperation("", { skipBlocklist: true });
      if (guardErr) {
        return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
      }
    }

    const result = await rpcCall(rpcMethod, { ...scopeParams, ...args });
    if (result && typeof result === "object" && result.ok === false) {
      return {
        content: [{ type: "text", text: formatRpcError(result) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  };
}

function registerMcpTools(server, deps) {
  const tools = listMcpTools();
  for (const toolDef of tools) {
    if (!toolDef.mcpTool || !toolDef.rpcMethod) continue;
    const handler = createToolHandler(toolDef, deps);
    const toolDescription = deps.catalogDescription(toolDef.mcpTool, toolDef.description);
    // Empty Zod objects reject omitted `arguments`. MCP allows omitting them
    // for no-arg tools; skip the schema so both omitted and {} are valid.
    if (isEmptyMcpInputShape(toolDef.inputShape)) {
      server.tool(toolDef.mcpTool, toolDescription, async () => handler({}));
      continue;
    }
    server.tool(toolDef.mcpTool, toolDescription, buildZodShapeObject(toolDef.inputShape), handler);
  }
  return tools.length;
}

module.exports = {
  buildZodSchema,
  buildZodShapeObject,
  isEmptyMcpInputShape,
  formatRpcError,
  formatTerminalExecuteResult,
  formatTerminalExecuteMcpResponse,
  hasTerminalExecuteEvidence,
  registerMcpTools,
  SFTP_WRITE_TOOLS,
};
