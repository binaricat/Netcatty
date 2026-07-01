"use strict";

const { z } = require("zod");
const { listMcpTools } = require("./toolSurfaces.cjs");

const TERMINAL_EXECUTE_TOOLS = new Set(["terminal_execute"]);
const TERMINAL_START_TOOLS = new Set(["terminal_start"]);
const TERMINAL_POLL_TOOLS = new Set(["terminal_poll"]);
const TERMINAL_STOP_TOOLS = new Set(["terminal_stop"]);
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

function formatRpcError(result) {
  return `Error: ${result?.error || "Operation failed"}`;
}

function formatTerminalExecuteResult(result) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
  if (result.exitCode != null) {
    parts.push(`[exit code: ${result.exitCode}]`);
  }
  return parts.join("\n");
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
      if (!result.ok) {
        return { content: [{ type: "text", text: formatRpcError(result) }], isError: true };
      }
      if (TERMINAL_START_TOOLS.has(mcpTool)) {
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
      return { content: [{ type: "text", text: formatTerminalExecuteResult(result) }] };
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
    const schemaShape = buildZodShapeObject(toolDef.inputShape);
    const handler = createToolHandler(toolDef, deps);
    const toolDescription = deps.catalogDescription(toolDef.mcpTool, toolDef.description);
    server.tool(toolDef.mcpTool, toolDescription, schemaShape, handler);
  }
  return tools.length;
}

module.exports = {
  buildZodSchema,
  buildZodShapeObject,
  registerMcpTools,
  SFTP_WRITE_TOOLS,
};
