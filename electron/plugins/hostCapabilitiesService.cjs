"use strict";

const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { probeRemoteDesktop } = require("../bridges/remoteDesktopProbe.cjs");

const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);

const MAX_CONCURRENT_PROBES_PER_RUNTIME = 12;
const MAX_CONCURRENT_PROBES_TOTAL = 48;
const MAX_TERMINAL_SCREEN_BYTES = 262_144;
const ALLOWED_LOOPBACK_BIND_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);

function probeTcpReachability({ host, port, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = new net.Socket();
    let settled = false;
    let banner = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ...result, checkedAt: Date.now() });
    };
    const onAbort = () => finish({ reachable: false, protocol: "ssh", port, rttMs: null, bannerVerified: false, error: "Probe cancelled" });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(timeoutMs);
    const onConnectTimeout = () => finish({ reachable: false, protocol: "ssh", port, rttMs: null, bannerVerified: false, error: "Connection timed out" });
    socket.once("connect", () => {
      socket.removeListener("timeout", onConnectTimeout);
      const rttMs = Math.max(0, Math.round(performance.now() - startedAt));
      socket.setTimeout(Math.min(timeoutMs, 1500));
      socket.once("data", (chunk) => {
        banner = chunk.toString("utf8").split(/\r?\n/)[0].slice(0, 200);
        const verified = banner.startsWith("SSH-");
        finish({
          reachable: true,
          protocol: "ssh",
          port,
          rttMs,
          bannerVerified: verified,
          ...(banner ? { bannerDetail: banner } : {}),
        });
      });
      socket.once("timeout", () => {
        finish({ reachable: true, protocol: "ssh", port, rttMs, bannerVerified: false });
      });
    });
    socket.once("timeout", onConnectTimeout);
    socket.once("error", (err) => finish({ reachable: false, protocol: "ssh", port, rttMs: null, bannerVerified: false, error: String(err?.message || "Connection failed").slice(0, 256) }));
    socket.connect(port, host);
  });
}

/**
 * Registers extended safe Netcatty host capabilities for ordinary browserOnly
 * plugins: host probing, pooled SFTP, Vault groups/annotations, Port Forwarding,
 * Snippets, Terminal session inspection/control, and Workspace tabs.
 */
class PluginHostCapabilitiesService {
  constructor({
    hostVaultService,
    vaultDataBridge,
    sshSftpTransport,
    database,
    probeRemoteDesktopFn = probeRemoteDesktop,
    probeTcpFn = probeTcpReachability,
    isLocked = () => false,
    subscribeLock,
  }) {
    this.hostVaultService = hostVaultService;
    this.vaultDataBridge = vaultDataBridge;
    this.sshSftpTransport = sshSftpTransport;
    this.database = database ?? null;
    this.probeRemoteDesktop = probeRemoteDesktopFn;
    this.probeTcp = probeTcpFn;
    this.isLocked = isLocked;
    this.activeProbes = new Set();
    this.closed = false;

    this.validators = Object.fromEntries([
      "VaultHostProbeParams",
      "VaultHostSftpPathParams",
      "VaultHostSftpReadParams",
      "VaultHostSftpWriteParams",
      "VaultHostSftpDeleteParams",
      "VaultUpdateHostNotesParams",
      "VaultUpdateHostTagsParams",
      "PortForwardCreateParams",
      "PortForwardRuleIdParams",
      "SnippetListParams",
      "SnippetGetParams",
      "SnippetSaveParams",
      "SnippetDeleteParams",
      "TerminalReadScreenParams",
      "TerminalSendInputParams",
      "WorkspaceFocusTabParams",
    ].map((name) => [name, createDefinitionValidator(name)]));

    this.unsubscribeLock = subscribeLock?.((state) => {
      if (state?.locked) this.#abortAllProbes("Application locked");
    }) ?? null;
  }

  #validate(name, params) {
    if (!this.validators[name](params ?? {})) {
      throw fail("invalidArgument", `Invalid parameters for ${name}`);
    }
    return Object.freeze(structuredClone(params ?? {}));
  }

  #requireFeature(context, feature) {
    if (!context.manifest?.features?.required?.includes(feature)) {
      throw fail("unsupported", `Required feature was not negotiated: ${feature}`);
    }
  }

  #abortAllProbes(reason) {
    for (const entry of [...this.activeProbes]) {
      entry.controller.abort(fail("unavailable", reason));
    }
  }

  #prepareSftpContext(params, context) {
    const hostId = this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
    return {
      runtimeId: context.runtimeId,
      pluginId: context.pluginId,
      hostId,
      prepareConnection: async (id, signal) => {
        const prepared = await this.vaultDataBridge.prepareConnection(id, signal);
        return prepared?.connectionOptions ?? null;
      },
      signal: context.signal,
      assertActive: async () => {
        await context.assertActive();
        this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
      },
    };
  }

  registerRpcCapabilities(registry) {
    // 1. Host Reachability / RDP / VNC / SSH Probe
    registry.registerRequest("vault.probeHost", (params, context) => this.probeHost(params, context), {
      metadata: { capability: "vault", mutating: false },
      validateParams: (params) => this.#validate("VaultHostProbeParams", params),
      authorization: (params, context) => {
        this.#requireFeature(context, "vault.host-probe");
        this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
        return {
          permission: "vault.metadata",
          resources: ["*"],
          reason: "Probe network reachability and protocol banner of a bound saved server",
          operationId: "vault.probeHost",
        };
      },
    });

    // 2. Pooled SFTP Operations
    const sftpOps = [
      ["vault.sftp.listDir", "VaultHostSftpPathParams", "sftp.read", false, (p, c) => this.sshSftpTransport.listDir(this.#prepareSftpContext(p, c), p.path)],
      ["vault.sftp.stat", "VaultHostSftpPathParams", "sftp.read", false, (p, c) => this.sshSftpTransport.stat(this.#prepareSftpContext(p, c), p.path)],
      ["vault.sftp.readFile", "VaultHostSftpReadParams", "sftp.read", false, (p, c) => this.sshSftpTransport.readFile(this.#prepareSftpContext(p, c), p)],
      ["vault.sftp.writeFile", "VaultHostSftpWriteParams", "sftp.write", true, (p, c) => this.sshSftpTransport.writeFile(this.#prepareSftpContext(p, c), p)],
      ["vault.sftp.mkdir", "VaultHostSftpPathParams", "sftp.write", true, (p, c) => this.sshSftpTransport.mkdir(this.#prepareSftpContext(p, c), p.path)],
      ["vault.sftp.delete", "VaultHostSftpDeleteParams", "sftp.write", true, (p, c) => this.sshSftpTransport.delete(this.#prepareSftpContext(p, c), p)],
    ];
    for (const [method, schemaName, permission, mutating, handler] of sftpOps) {
      registry.registerRequest(method, async (params, context) => {
        await context.assertActive();
        if (!this.sshSftpTransport || !this.vaultDataBridge) throw fail("unavailable", "Host SFTP is unavailable");
        return handler(params, context);
      }, {
        metadata: { capability: "sftp", mutating },
        validateParams: (params) => this.#validate(schemaName, params),
        authorization: (params, context) => {
          this.#requireFeature(context, "vault.host-sftp");
          this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
          return {
            permission,
            resources: ["*"],
            reason: mutating ? "Modify remote files over SFTP on a bound server" : "Read remote files or directories over SFTP on a bound server",
            operationId: method,
          };
        },
      });
    }

    // 3. Vault Groups & Non-Secret Host Annotations
    registry.registerRequest("vault.listGroups", async (_params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("listGroups", {}, context.signal);
    }, {
      metadata: { capability: "vault", mutating: false },
      authorization: (_params, context) => {
        this.#requireFeature(context, "vault.host-actions");
        return { permission: "vault.metadata", resources: ["*"], reason: "List Vault host groups", operationId: "vault.listGroups" };
      },
    });

    registry.registerRequest("vault.updateHostNotes", async (params, context) => {
      await context.assertActive();
      const hostId = this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
      return this.vaultDataBridge.request("updateHostNotes", { hostId, notes: params.notes }, context.signal);
    }, {
      metadata: { capability: "vault", mutating: true },
      validateParams: (params) => this.#validate("VaultUpdateHostNotesParams", params),
      authorization: (params, context) => {
        this.#requireFeature(context, "vault.host-actions");
        this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
        return { permission: "vault.write", resources: ["*"], reason: "Update non-secret notes on a bound saved server", operationId: "vault.updateHostNotes" };
      },
    });

    registry.registerRequest("vault.updateHostTags", async (params, context) => {
      await context.assertActive();
      const hostId = this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
      return this.vaultDataBridge.request("updateHostTags", { hostId, tags: params.tags }, context.signal);
    }, {
      metadata: { capability: "vault", mutating: true },
      validateParams: (params) => this.#validate("VaultUpdateHostTagsParams", params),
      authorization: (params, context) => {
        this.#requireFeature(context, "vault.host-actions");
        this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
        return { permission: "vault.write", resources: ["*"], reason: "Update non-secret tags on a bound saved server", operationId: "vault.updateHostTags" };
      },
    });

    // 4. Port Forwarding Management
    registry.registerRequest("portForward.list", async (_params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("portForward.list", {}, context.signal);
    }, {
      metadata: { capability: "portForward", mutating: false },
      authorization: (_params, context) => {
        this.#requireFeature(context, "vault.port-forwarding");
        return { permission: "portForward.read", resources: ["*"], reason: "List saved port-forwarding rules", operationId: "portForward.list" };
      },
    });

    registry.registerRequest("portForward.create", async (params, context) => {
      await context.assertActive();
      const hostId = this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
      const { hostBindingToken: _token, ...ruleInput } = params;
      const bindAddress = (ruleInput.bindAddress ?? "127.0.0.1").trim().toLowerCase();
      if (!ALLOWED_LOOPBACK_BIND_ADDRESSES.has(bindAddress)) {
        throw fail("invalidArgument", "Plugin port forwarding bindAddress must be a loopback address (127.0.0.1, ::1, or localhost)");
      }
      return this.vaultDataBridge.request("portForward.create", {
        ...ruleInput,
        hostId,
        bindAddress,
      }, context.signal);
    }, {
      metadata: { capability: "portForward", mutating: true },
      validateParams: (params) => this.#validate("PortForwardCreateParams", params),
      authorization: (params, context) => {
        this.#requireFeature(context, "vault.port-forwarding");
        this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
        return { permission: "portForward.manage", resources: ["*"], reason: "Create a port-forwarding rule on a bound server", operationId: "portForward.create" };
      },
    });

    for (const op of ["start", "stop", "delete"]) {
      registry.registerRequest(`portForward.${op}`, async (params, context) => {
        await context.assertActive();
        return this.vaultDataBridge.request(`portForward.${op}`, { ruleId: params.ruleId }, context.signal);
      }, {
        metadata: { capability: "portForward", mutating: true },
        validateParams: (params) => this.#validate("PortForwardRuleIdParams", params),
        authorization: (_params, context) => {
          this.#requireFeature(context, "vault.port-forwarding");
          return { permission: "portForward.manage", resources: ["*"], reason: `Manage port-forwarding tunnel (${op})`, operationId: `portForward.${op}` };
        },
      });
    }

    // 5. Snippets Library
    registry.registerRequest("snippets.list", async (params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("snippets.list", params ?? {}, context.signal);
    }, {
      metadata: { capability: "snippets", mutating: false },
      validateParams: (params) => this.#validate("SnippetListParams", params ?? {}),
      authorization: (_params, context) => {
        this.#requireFeature(context, "vault.snippets");
        return { permission: "snippets.read", resources: ["*"], reason: "List saved snippets and scripts", operationId: "snippets.list" };
      },
    });

    registry.registerRequest("snippets.get", async (params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("snippets.get", { id: params.id }, context.signal);
    }, {
      metadata: { capability: "snippets", mutating: false },
      validateParams: (params) => this.#validate("SnippetGetParams", params),
      authorization: (_params, context) => {
        this.#requireFeature(context, "vault.snippets");
        return { permission: "snippets.read", resources: ["*"], reason: "Read a saved snippet or script", operationId: "snippets.get" };
      },
    });

    registry.registerRequest("snippets.save", async (params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("snippets.save", params, context.signal);
    }, {
      metadata: { capability: "snippets", mutating: true },
      validateParams: (params) => this.#validate("SnippetSaveParams", params),
      authorization: (_params, context) => {
        this.#requireFeature(context, "vault.snippets");
        return { permission: "snippets.write", resources: ["*"], reason: "Create or update a saved snippet", operationId: "snippets.save" };
      },
    });

    registry.registerRequest("snippets.delete", async (params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("snippets.delete", { id: params.id }, context.signal);
    }, {
      metadata: { capability: "snippets", mutating: true },
      validateParams: (params) => this.#validate("SnippetDeleteParams", params),
      authorization: (_params, context) => {
        this.#requireFeature(context, "vault.snippets");
        return { permission: "snippets.write", resources: ["*"], reason: "Delete a saved snippet", operationId: "snippets.delete" };
      },
    });

    // 6. Terminal Session Inspection & Safe Control
    registry.registerRequest("terminals.listSessions", async (_params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("terminals.listSessions", {}, context.signal);
    }, {
      metadata: { capability: "terminal", mutating: false },
      authorization: (_params, context) => {
        this.#requireFeature(context, "terminal.session-control");
        return { permission: "terminal.metadata", resources: ["*"], reason: "List open terminal sessions", operationId: "terminals.listSessions" };
      },
    });

    registry.registerRequest("terminals.readScreen", async (params, context) => {
      await context.assertActive();
      const maxRows = Math.max(1, Math.min(300, params.maxRows ?? 80));
      const result = await this.vaultDataBridge.request("terminals.readScreen", { sessionId: params.sessionId, maxRows }, context.signal);
      if (result && Array.isArray(result.lines)) {
        const bounded = [];
        let bytes = 0;
        for (const line of result.lines.slice(-maxRows)) {
          const text = String(line ?? "").slice(0, 4096);
          const len = Buffer.byteLength(text, "utf8");
          if (bytes + len > MAX_TERMINAL_SCREEN_BYTES) break;
          bytes += len;
          bounded.push(text);
        }
        return { ...result, lines: bounded };
      }
      return result;
    }, {
      metadata: { capability: "terminal", mutating: false },
      validateParams: (params) => this.#validate("TerminalReadScreenParams", params),
      authorization: (_params, context) => {
        this.#requireFeature(context, "terminal.session-control");
        return { permission: "terminal.output", resources: ["*"], reason: "Read bounded terminal screen output", operationId: "terminals.readScreen" };
      },
    });

    registry.registerRequest("terminals.sendInput", async (params, context) => {
      await context.assertActive();
      if (this.isLocked()) throw fail("unavailable", "Terminal input is unavailable while locked");
      const byteLength = Buffer.byteLength(params.data, "utf8");
      if (byteLength > 8192) throw fail("invalidArgument", "Terminal input exceeds byte limit");
      this.database?.recordSecurityAudit?.(context.pluginId, "terminal.sendInput", {
        sessionId: params.sessionId,
        bytes: byteLength,
      });
      return this.vaultDataBridge.request("terminals.sendInput", { sessionId: params.sessionId, data: params.data }, context.signal);
    }, {
      metadata: { capability: "terminal", mutating: true },
      validateParams: (params) => this.#validate("TerminalSendInputParams", params),
      authorization: (_params, context) => {
        this.#requireFeature(context, "terminal.session-control");
        return { permission: "terminal.input", resources: ["*"], reason: "Send bounded input to an open terminal session", operationId: "terminals.sendInput" };
      },
    });

    registry.registerRequest("terminals.openLocal", async (_params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("terminals.openLocal", {}, context.signal);
    }, {
      metadata: { capability: "terminal", mutating: true },
      authorization: (_params, context) => {
        this.#requireFeature(context, "terminal.session-control");
        return { permission: "ui.interact", resources: ["*"], reason: "Open a new local terminal tab", operationId: "terminals.openLocal" };
      },
    });

    // 7. Workspace Tabs
    registry.registerRequest("workspace.listTabs", async (_params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("workspace.listTabs", {}, context.signal);
    }, {
      metadata: { capability: "workspace", mutating: false },
      authorization: (_params, context) => {
        this.#requireFeature(context, "workspace.tabs");
        return { permission: "workspace.read", resources: ["*"], reason: "List open Netcatty tabs", operationId: "workspace.listTabs" };
      },
    });

    registry.registerRequest("workspace.focusTab", async (params, context) => {
      await context.assertActive();
      return this.vaultDataBridge.request("workspace.focusTab", { tabId: params.tabId }, context.signal);
    }, {
      metadata: { capability: "workspace", mutating: true },
      validateParams: (params) => this.#validate("WorkspaceFocusTabParams", params),
      authorization: (_params, context) => {
        this.#requireFeature(context, "workspace.tabs");
        return { permission: "workspace.navigate", resources: ["*"], reason: "Switch focus to an open Netcatty tab", operationId: "workspace.focusTab" };
      },
    });
  }

  async probeHost(params, context) {
    await context.assertActive();
    if (this.closed || this.isLocked()) throw fail("unavailable", "Host probe is unavailable");
    if (!this.vaultDataBridge) throw fail("unavailable", "Vault data host is unavailable");

    const runtimeInflight = [...this.activeProbes].filter((item) => item.runtimeId === context.runtimeId).length;
    if (runtimeInflight >= MAX_CONCURRENT_PROBES_PER_RUNTIME || this.activeProbes.size >= MAX_CONCURRENT_PROBES_TOTAL) {
      throw fail("resourceExhausted", "Too many concurrent host probes");
    }

    const hostId = this.hostVaultService.resolveDurableHostId(context.pluginId, params.hostBindingToken, context.sourceOwner);
    const controller = new AbortController();
    const lease = { controller, runtimeId: context.runtimeId, pluginId: context.pluginId };
    if (context.signal?.aborted) {
      throw fail("cancelled", "Host probe was cancelled");
    }
    this.activeProbes.add(lease);
    const onAbort = () => controller.abort(context.signal?.reason ?? fail("cancelled", "Host probe was cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const target = await this.vaultDataBridge.request("prepareProbeTarget", { hostId }, controller.signal);
      await context.assertActive();
      if (!target || typeof target.hostname !== "string" || !target.hostname) {
        throw fail("notFound", "Bound host is no longer available");
      }

      // Anti-port-scan guard: restrict protocol & port strictly to the saved host's configured ports.
      const allowedPorts = new Map();
      const rawSshPort = Number(target.sshPort);
      if (Number.isSafeInteger(rawSshPort) && rawSshPort >= 1 && rawSshPort <= 65535) {
        allowedPorts.set("ssh", rawSshPort);
      } else if (!target.rdpPort && !target.vncPort && target.defaultProtocol !== "rdp" && target.defaultProtocol !== "vnc") {
        allowedPorts.set("ssh", 22);
      }
      if (target.rdpPort) allowedPorts.set("rdp", Number(target.rdpPort));
      if (target.vncPort) allowedPorts.set("vnc", Number(target.vncPort));

      const protocol = params.protocol ?? (target.defaultProtocol === "rdp" || target.defaultProtocol === "vnc" ? target.defaultProtocol : "ssh");
      const configuredPort = allowedPorts.get(protocol);
      if (!configuredPort) {
        throw fail("failedPrecondition", `Protocol ${protocol} is not configured on this saved host`);
      }
      if (params.port !== undefined && params.port !== configuredPort) {
        throw fail("permissionDenied", "Probe port must match the saved host configuration");
      }

      const timeoutMs = Math.max(1_000, Math.min(10_000, params.timeoutMs ?? 5_000));
      if (protocol === "rdp" || protocol === "vnc") {
        const res = await this.probeRemoteDesktop(
          {
            protocol,
            host: target.hostname,
            port: configuredPort,
            securityMode: target.rdpSecurityMode || "auto",
            mode: "heartbeat",
            tcpTimeoutMs: timeoutMs,
            handshakeTimeoutMs: Math.min(timeoutMs, 3_000),
          },
          { signal: controller.signal },
        );
        return {
          reachable: Boolean(res?.ok || res?.reachable),
          protocol,
          port: configuredPort,
          rttMs: typeof res?.rttMs === "number" && Number.isFinite(res.rttMs) ? Math.max(0, Math.round(res.rttMs)) : null,
          bannerVerified: Boolean(res?.bannerVerified),
          ...(typeof res?.bannerDetail === "string" && res.bannerDetail ? { bannerDetail: res.bannerDetail.slice(0, 512) } : {}),
          ...(typeof res?.error === "string" && res.error ? { error: res.error.slice(0, 512) } : {}),
          checkedAt: typeof res?.checkedAt === "number" ? res.checkedAt : Date.now(),
        };
      }

      return await this.probeTcp({ host: target.hostname, port: configuredPort, timeoutMs, signal: controller.signal });
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      this.activeProbes.delete(lease);
    }
  }

  releaseRuntime(runtimeId) {
    for (const entry of [...this.activeProbes]) {
      if (entry.runtimeId === runtimeId) entry.controller.abort(fail("cancelled", "Plugin runtime stopped"));
    }
  }

  releasePlugin(pluginId) {
    for (const entry of [...this.activeProbes]) {
      if (entry.pluginId === pluginId) entry.controller.abort(fail("permissionDenied", "Plugin disabled"));
    }
  }

  shutdown() {
    this.closed = true;
    try { this.unsubscribeLock?.(); } catch { /* ignore */ }
    this.unsubscribeLock = null;
    this.#abortAllProbes("Plugin host shutting down");
  }
}

module.exports = { PluginHostCapabilitiesService, probeTcpReachability };
