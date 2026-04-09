#!/usr/bin/env node
"use strict";

const { connectClient, createError } = require("./netcattyRpcClient.cjs");

function printHelp() {
  process.stdout.write(
    "Netcatty Tool CLI\n\n" +
    "Usage:\n" +
    "  netcatty-tool-cli status [--json]\n" +
    "  netcatty-tool-cli env --chat-session <id> [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli session --session <id> --chat-session <id> [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli resource environment --chat-session <id> [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli exec --session <id> --chat-session <id> [--json] [--] <command>\n" +
    "  netcatty-tool-cli sftp list --session <id> --remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp read --session <id> --remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp write --session <id> --remote-path <remote-path> --content <text> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp download --session <id> --remote-path <remote-path> --local-path <local-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp upload --session <id> --local-path <local-path> --remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp mkdir --session <id> --remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp delete --session <id> --remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp rename --session <id> --old-remote-path <remote-path> --new-remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp stat --session <id> --remote-path <remote-path> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp chmod --session <id> --remote-path <remote-path> --mode <octal> --chat-session <id> [--encoding <enc>] [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli sftp home --session <id> --chat-session <id> [--json] [--scope-session <session-id> ...]\n" +
    "  netcatty-tool-cli cancel --chat-session <id> [--json]\n" +
    "  netcatty-tool-cli resume --chat-session <id> [--json]\n" +
    "  netcatty-tool-cli help\n\n" +
    "Examples:\n" +
    "  netcatty-tool-cli status --json\n" +
    "  netcatty-tool-cli env --chat-session ai_123 --json\n" +
    "  netcatty-tool-cli session --session sess_123 --json --chat-session ai_123\n" +
    "  netcatty-tool-cli exec --session sess_123 --chat-session ai_123 --json -- pwd\n" +
    "  netcatty-tool-cli sftp list --session sess_123 --remote-path /etc --chat-session ai_123 --json\n" +
    "  netcatty-tool-cli sftp download --session sess_123 --remote-path /etc/hosts --local-path ./hosts.txt --chat-session ai_123 --json\n\n" +
    "Notes:\n" +
    "  - Start the Netcatty desktop app before using this CLI.\n" +
    "  - This CLI is intended as an internal Skills + CLI transport, not a general customer-facing shell tool.\n" +
    "  - `env`, `session`, and `resource environment` always require --chat-session <id>.\n" +
    "  - `exec` always requires both --session <id> and --chat-session <id>.\n" +
    "  - Every `sftp <op>` always requires both --session <id> and --chat-session <id>.\n" +
    "  - `cancel` stops in-flight executions and blocks further execs for that chat session until `resume`.\n" +
    "  - TODO: Add explicit batch execution / cancellation commands if the MCP surface expands.\n",
  );
}

function toErrorPayload(err) {
  return {
    ok: false,
    error: {
      code: err?.code || "UNKNOWN_ERROR",
      message: err?.message || String(err),
    },
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    json: false,
    chatSessionId: null,
    scopedSessionIds: [],
    sessionId: null,
    remotePath: null,
    localPath: null,
    oldRemotePath: null,
    newRemotePath: null,
    content: null,
    mode: null,
    encoding: null,
    command: [],
  };

  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      opts.command = args.slice(i + 1);
      break;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--chat-session") {
      opts.chatSessionId = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--scope-session") {
      const value = args[i + 1] || null;
      if (value) opts.scopedSessionIds.push(value);
      i += 1;
      continue;
    }
    if (arg === "--session") {
      opts.sessionId = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--remote-path") {
      opts.remotePath = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--local-path") {
      opts.localPath = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--old-remote-path") {
      opts.oldRemotePath = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--new-remote-path") {
      opts.newRemotePath = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--content") {
      opts.content = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      opts.mode = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--encoding") {
      opts.encoding = args[i + 1] || null;
      i += 1;
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, opts };
}

function formatEnvText(ctx) {
  const header = [
    `Environment: ${ctx.environment || "netcatty-terminal"}`,
    `Hosts: ${ctx.hostCount || 0}`,
  ];
  if (!Array.isArray(ctx.hosts) || ctx.hosts.length === 0) {
    return `${header.join("\n")}\n\nNo hosts are available in the current scope.\n`;
  }
  const rows = ctx.hosts.map((host) => {
    const details = [
      host.sessionId,
      host.label || host.hostname || "(unnamed)",
      host.protocol || "unknown",
      host.os || host.deviceType || host.shellType || "unknown",
      host.connected === false ? "disconnected" : "connected",
    ];
    return details.join("\t");
  });
  return `${header.join("\n")}\n\n${rows.join("\n")}\n`;
}

function formatExecText(result) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
  if (result.stderr) parts.push(`[stderr] ${result.stderr.replace(/\n$/, "")}`);
  if (result.exitCode != null) parts.push(`[exit code: ${result.exitCode}]`);
  if (parts.length === 0) {
    parts.push("[no output]");
  }
  return `${parts.join("\n")}\n`;
}

function buildScopeParams(opts) {
  if (opts.chatSessionId) {
    return { chatSessionId: opts.chatSessionId };
  }
  if (Array.isArray(opts.scopedSessionIds) && opts.scopedSessionIds.length > 0) {
    return { scopedSessionIds: opts.scopedSessionIds };
  }
  return {};
}

function findHostOrThrow(ctx, sessionId) {
  const host = Array.isArray(ctx?.hosts)
    ? ctx.hosts.find((item) => item.sessionId === sessionId)
    : null;
  if (!host) {
    throw createError("SESSION_NOT_FOUND", `Session "${sessionId}" is not available in the current scope.`);
  }
  return host;
}

async function resolveTargetHost(client, opts) {
  const ctx = await client.call("netcatty/getContext", buildScopeParams(opts));
  if (opts.sessionId) {
    return findHostOrThrow(ctx, opts.sessionId);
  }
  throw createError(
    "INVALID_ARGUMENT",
    "Missing required --session <id>. Run env --json to inspect available sessions first.",
  );
}

function formatSessionText(host) {
  const lines = [
    `Session: ${host.sessionId}`,
    `Label: ${host.label || "(unnamed)"}`,
    `Hostname: ${host.hostname || ""}`,
    `Protocol: ${host.protocol || "unknown"}`,
    `OS: ${host.os || ""}`,
    `Username: ${host.username || ""}`,
    `Shell Type: ${host.shellType || ""}`,
    `Device Type: ${host.deviceType || ""}`,
    `Connected: ${host.connected === false ? "false" : "true"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatStatusText(status) {
  const lines = [
    "Netcatty Tool Status",
    `Permission Mode: ${status.permissionMode || "unknown"}`,
    `Command Timeout (ms): ${status.commandTimeoutMs ?? "unknown"}`,
    `Max Iterations: ${status.maxIterations ?? "unknown"}`,
    `Sessions: ${status.sessionCount ?? 0}`,
    `Scoped Contexts: ${status.scopedContextCount ?? 0}`,
    `Active Executions: ${status.activeExecutionCount ?? 0}`,
    `Active Chat Execution Locks: ${status.activeChatExecutionCount ?? 0}`,
    `Pending Approvals: ${status.pendingApprovalCount ?? 0}`,
    `Discovery File: ${status.discoveryFilePath || "(none)"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatSftpListText(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "No entries.\n";
  }
  const rows = entries.map((entry) => [
    entry.type || "file",
    entry.name || "",
    entry.size || "",
    entry.permissions || "",
    entry.lastModified || "",
  ].join("\t"));
  return `Type\tName\tSize\tPermissions\tModified\n${rows.join("\n")}\n`;
}

async function run() {
  const { positionals, opts } = parseArgs(process.argv);
  const [command, subcommand] = positionals;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  let client = null;
  try {
    client = await connectClient();

    if (command === "status") {
      const result = await client.call("netcatty/getStatus", {});
      const output = opts.json ? JSON.stringify(result, null, 2) : formatStatusText(result);
      process.stdout.write(`${output}${opts.json ? "\n" : ""}`);
      return;
    }

    if (command === "env") {
      if (!opts.chatSessionId) {
        throw createError("INVALID_ARGUMENT", "Missing required --chat-session <id> for env.");
      }
      const params = buildScopeParams(opts);
      const result = await client.call("netcatty/getContext", params);
      const output = opts.json ? JSON.stringify({ ok: true, ...result }, null, 2) : formatEnvText(result);
      process.stdout.write(`${output}${opts.json ? "\n" : ""}`);
      return;
    }

    if (command === "session") {
      if (!opts.chatSessionId) {
        throw createError("INVALID_ARGUMENT", "Missing required --chat-session <id> for session.");
      }
      const host = await resolveTargetHost(client, opts);
      const payload = { ok: true, host };
      const output = opts.json ? JSON.stringify(payload, null, 2) : formatSessionText(host);
      process.stdout.write(`${output}${opts.json ? "\n" : ""}`);
      return;
    }

    if (command === "resource" && subcommand === "environment") {
      if (!opts.chatSessionId) {
        throw createError("INVALID_ARGUMENT", "Missing required --chat-session <id> for resource environment.");
      }
      const params = buildScopeParams(opts);
      const ctx = await client.call("netcatty/getContext", params);
      const resource = {
        ok: true,
        contents: [{
          uri: "netcatty://context",
          mimeType: "application/json",
          text: JSON.stringify(ctx, null, 2),
        }],
      };
      const output = opts.json ? JSON.stringify(resource, null, 2) : `${resource.contents[0].text}\n`;
      process.stdout.write(`${output}${opts.json ? "\n" : ""}`);
      return;
    }

    if (command === "exec") {
      if (!opts.chatSessionId) {
        throw createError("INVALID_ARGUMENT", "Missing required --chat-session <id> for exec.");
      }
      if (!opts.command.length) {
        throw createError("INVALID_ARGUMENT", "Missing command after --.");
      }
      const host = await resolveTargetHost(client, opts);
      const rpcParams = {
        sessionId: host.sessionId,
        command: opts.command.join(" "),
        chatSessionId: opts.chatSessionId,
      };
      const result = await client.call("netcatty/exec", rpcParams);
      if (result.ok === false) {
        const err = createError(result.code || "EXEC_FAILED", result.error || "Command failed");
        err.details = result;
        throw err;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      } else {
        process.stdout.write(formatExecText(result));
      }
      return;
    }

    if (command === "sftp") {
      if (!opts.chatSessionId) {
        throw createError("INVALID_ARGUMENT", "Missing required --chat-session <id> for sftp.");
      }
      if (!subcommand || subcommand === "help") {
        printHelp();
        return;
      }

      const host = await resolveTargetHost(client, opts);
      const buildSftpParams = () => {
        const params = {
          sessionId: host.sessionId,
          chatSessionId: opts.chatSessionId,
          ...buildScopeParams(opts),
        };
        if (opts.remotePath) params.remotePath = opts.remotePath;
        if (opts.localPath) params.localPath = opts.localPath;
        if (opts.remotePath) params.path = opts.remotePath;
        if (opts.oldRemotePath) params.oldPath = opts.oldRemotePath;
        if (opts.newRemotePath) params.newPath = opts.newRemotePath;
        if (opts.content != null) params.content = opts.content;
        if (opts.mode) params.mode = opts.mode;
        if (opts.encoding) params.encoding = opts.encoding;
        return params;
      };

      if (subcommand === "list") {
        if (!opts.remotePath) throw createError("INVALID_ARGUMENT", "Missing required --remote-path <remote-path> for sftp list.");
        const result = await client.call("netcatty/sftp/list", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatSftpListText(result.entries));
        return;
      }

      if (subcommand === "read") {
        if (!opts.remotePath) throw createError("INVALID_ARGUMENT", "Missing required --remote-path <remote-path> for sftp read.");
        const result = await client.call("netcatty/sftp/read", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${result.content}${result.content?.endsWith("\n") ? "" : "\n"}`);
        return;
      }

      if (subcommand === "write") {
        if (!opts.remotePath) throw createError("INVALID_ARGUMENT", "Missing required --remote-path <remote-path> for sftp write.");
        if (opts.content == null) throw createError("INVALID_ARGUMENT", "Missing required --content <text> for sftp write.");
        const result = await client.call("netcatty/sftp/write", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Wrote ${opts.remotePath}.\n`);
        return;
      }

      if (subcommand === "download") {
        if (!opts.remotePath || !opts.localPath) {
          throw createError("INVALID_ARGUMENT", "Missing required --remote-path and --local-path for sftp download.");
        }
        const result = await client.call("netcatty/sftp/download", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Downloaded ${opts.remotePath} -> ${opts.localPath}.\n`);
        return;
      }

      if (subcommand === "upload") {
        if (!opts.remotePath || !opts.localPath) {
          throw createError("INVALID_ARGUMENT", "Missing required --local-path and --remote-path for sftp upload.");
        }
        const result = await client.call("netcatty/sftp/upload", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Uploaded ${opts.localPath} -> ${opts.remotePath}.\n`);
        return;
      }

      if (subcommand === "mkdir") {
        if (!opts.remotePath) throw createError("INVALID_ARGUMENT", "Missing required --remote-path <remote-path> for sftp mkdir.");
        const result = await client.call("netcatty/sftp/mkdir", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Created ${opts.remotePath}.\n`);
        return;
      }

      if (subcommand === "delete") {
        if (!opts.remotePath) throw createError("INVALID_ARGUMENT", "Missing required --remote-path <remote-path> for sftp delete.");
        const result = await client.call("netcatty/sftp/delete", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Deleted ${opts.remotePath}.\n`);
        return;
      }

      if (subcommand === "rename") {
        if (!opts.oldRemotePath || !opts.newRemotePath) {
          throw createError("INVALID_ARGUMENT", "Missing required --old-remote-path and --new-remote-path for sftp rename.");
        }
        const result = await client.call("netcatty/sftp/rename", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Renamed ${opts.oldRemotePath} -> ${opts.newRemotePath}.\n`);
        return;
      }

      if (subcommand === "stat") {
        if (!opts.remotePath) throw createError("INVALID_ARGUMENT", "Missing required --remote-path <remote-path> for sftp stat.");
        const result = await client.call("netcatty/sftp/stat", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${JSON.stringify(result.stat, null, 2)}\n`);
        return;
      }

      if (subcommand === "chmod") {
        if (!opts.remotePath || !opts.mode) {
          throw createError("INVALID_ARGUMENT", "Missing required --remote-path and --mode for sftp chmod.");
        }
        const result = await client.call("netcatty/sftp/chmod", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Changed mode of ${opts.remotePath} to ${opts.mode}.\n`);
        return;
      }

      if (subcommand === "home") {
        const result = await client.call("netcatty/sftp/home", buildSftpParams());
        process.stdout.write(opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${result.homeDir}\n`);
        return;
      }
    }

    if (command === "cancel" || command === "resume") {
      if (!opts.chatSessionId) {
        throw createError("INVALID_ARGUMENT", `Missing required --chat-session <id> for ${command}.`);
      }
      const cancelled = command === "cancel";
      const result = await client.call("netcatty/setCancelled", {
        chatSessionId: opts.chatSessionId,
        cancelled,
      });
      const payload = { ok: true, ...result };
      process.stdout.write(opts.json
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `Chat session ${opts.chatSessionId} ${cancelled ? "cancelled" : "resumed"}.\n`);
      return;
    }

    throw createError("INVALID_ARGUMENT", `Unknown command: ${positionals.join(" ")}`);
  } catch (err) {
    const payload = toErrorPayload(err);
    if (err?.details && typeof err.details === "object") {
      payload.error = {
        ...payload.error,
        ...err.details,
      };
    }
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  } finally {
    client?.close?.();
  }
}

run();
