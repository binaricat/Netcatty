"use strict";
/**
 * Real Electron end-to-end smoke test for com.binaricat.netcatty-monitor.
 * Exercises:
 * 1. Installing dist/netcatty-monitor-0.1.0.ncpkg into Netcatty's real PluginHostService.
 * 2. Opening the host-drawn Vault view via HostDrawnViewHost.open() in a sandboxed BrowserWindow.
 * 3. Validating initial Remote DOM mutations, canonical CSS, split-pane widget, and brand icon PNG decode.
 * 4. Clicking "+ Add Hosts" -> real vault.selectHosts({ durable: true }) issuing an hb_* binding token
 *    -> real vault.execHostCommand via PluginHostVaultService + mock sshExecTransport
 *    -> verifying live Linux host telemetry renders PluginMetricChart ("metric-chart") widgets!
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");

const pluginRoot = path.resolve(__dirname, "..");
const appRoot = path.resolve(pluginRoot, "../..");
const archivePath = path.join(pluginRoot, "dist", "netcatty-monitor-0.1.0.ncpkg");

const { createPluginHostService } = require(path.join(appRoot, "electron/plugins/hostService.cjs"));
const { PLUGIN_PROTOCOL_SCHEME } = require(path.join(appRoot, "electron/plugins/constants.cjs"));
const { validatePluginMutationBatch } = require(path.join(appRoot, "domain/pluginRemoteTreePolicy.cjs"));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-monitor-smoke-"));
electron.app.setPath("userData", userData);
electron.app.on("window-all-closed", () => {});
electron.protocol.registerSchemesAsPrivileged([
  {
    scheme: PLUGIN_PROTOCOL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

function flattenStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) flattenStrings(v, out);
  }
  return out;
}

function findButtonNodeIdByText(node, match) {
  if (!node || typeof node !== "object") return null;
  if (node.element === "button") {
    const text = flattenStrings(node.children).join(" ");
    if (text.includes(match)) return node.id;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findButtonNodeIdByText(child, match);
      if (found) return found;
    }
  }
  return null;
}

function findButtonIdInMutations(updates, match) {
  for (const update of updates) {
    for (const mutation of update.mutations || []) {
      if (Array.isArray(mutation) && mutation[0] === 0 && mutation[2]) {
        const found = findButtonNodeIdByText(mutation[2], match);
        if (found) return found;
      }
    }
  }
  return null;
}

void electron.app
  .whenReady()
  .then(async () => {
    assert.ok(fs.existsSync(archivePath), `Missing built archive: ${archivePath}`);

    const runtimeAppRoot = path.join(userData, "runtime-app");
    const runtimeDirectory = path.join(runtimeAppRoot, "electron/plugins/runtime");
    for (const name of ["plugin-contract", "plugin-sdk"]) {
      fs.cpSync(
        path.join(appRoot, "packages", name, "dist"),
        path.join(runtimeAppRoot, "node_modules/@netcatty", name, "dist"),
        { recursive: true },
      );
      fs.cpSync(
        path.join(appRoot, "packages", name, "package.json"),
        path.join(runtimeAppRoot, "node_modules/@netcatty", name, "package.json"),
      );
    }
    fs.cpSync(path.join(appRoot, "electron/plugins/runtime"), runtimeDirectory, { recursive: true });

    let execCount = 0;
    const mockHostRecord = {
      resourceId: "host-smoke-1",
      revision: "rev-1",
      label: "prod-smoke-01",
      hostname: "10.0.42.10",
      username: "ops",
      port: 22,
      group: "Production",
      tags: ["web", "smoke"],
      protocol: "ssh",
      os: "Ubuntu 24.04",
      notes: "Electron smoke test host",
    };

    const mockVaultDataBridge = {
      async resolveMetadata(hostIds) {
        return hostIds.map((id) =>
          id === mockHostRecord.resourceId
            ? { resourceId: id, found: true, metadata: { ...mockHostRecord } }
            : { resourceId: id, found: false },
        );
      },
      async prepareConnection(hostId) {
        assert.equal(hostId, mockHostRecord.resourceId);
        return {
          hostId,
          hostname: mockHostRecord.hostname,
          port: 22,
          username: "ops",
        };
      },
      invalidate() {},
      shutdown() {},
    };

    const mockSshExecTransport = {
      async exec({ command }) {
        execCount += 1;
        if (command.includes('DISKS:$disks')) {
          return {
            stdout: "DISKS:/:42.5:100.0:43:fs=ext4:/dev/nvme0n1p1|INODES:/:18400:100000:18",
            stderr: "",
            exitCode: 0,
            truncated: false,
            durationMs: 9,
            latencyMs: 14,
            responseLatencyMs: 17,
          };
        }
        if (command.includes("nvidia-smi")) {
          return {
            stdout: "GPU:58 4096 16384 NVIDIA L4 ;; 0\tNVIDIA L4\t58\t4096\t16384\t55\t68.0",
            stderr: "",
            exitCode: 0,
            truncated: false,
            durationMs: 7,
            latencyMs: 14,
            responseLatencyMs: 16,
          };
        }
        return {
          stdout:
            "OSFAM:linux|CPURAW:2400 1200 10 2 900 288|CPUEXTRA:12000 4500 2 0|CORES:4|PERCORERAW:600:300,600:300,600:300,600:300|MEMINFO:16384 4096 512 2048 2048 2048 4096 1024|NET:eth0:500000:250000:1200:800:0:0:0:0|TCPRETRANS:0|DISKIO:100.0;nvme0n1:100:200:50:60:400:1|PARTITIONIO:|DISKMOUNTS:|FD:2048:65536|USERS:2|REBOOT:0|THERMALS:x86_pkg_temp:52000|HOST:prod-smoke-01|OS:Ubuntu 24.04 LTS|KERNEL:6.8.0|UPTIME:7200|LOAD:0.55 0.48 0.40",
          stderr: "",
          exitCode: 0,
          truncated: false,
          durationMs: 14,
          latencyMs: 225,
          responseLatencyMs: 225,
        };
      },
      releaseHost() {},
      releaseRuntime() {},
      releasePlugin() {},
      closeAll() {},
      shutdown() {},
    };

    let owner = null;
    const service = createPluginHostService({
      app: electron.app,
      electron,
      appRoot: runtimeAppRoot,
      runtimeDirectory,
      vaultDataBridge: mockVaultDataBridge,
      sshExecTransport: mockSshExecTransport,
      getInteractionWindow: () => owner,
      isAppLocked: () => false,
      supportedFeatures: [
        "views.host-drawn",
        "views.vault-pages",
        "views.badges",
        "metadata.brand-icon",
        "vault.host-actions",
        "vault.host-exec",
        "vault.host-probe",
        "host.interactions",
      ],
      requestPermissionDecision: async (request) => ({
        requestId: request.requestId,
        decision: "allow",
        scope: "application",
      }),
    });

    await service.manager.initialize();
    const installed = await service.manager.install(archivePath, { enable: true });
    assert.equal(installed.manifest.id, "com.binaricat.netcatty-monitor");

    owner = new electron.BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    owner.isVisible = () => true;
    owner.isFocused = () => true;
    await owner.loadURL("about:blank");
    service.interactionService.setReady(owner.webContents, true);

    const updates = [];
    const origSend = owner.webContents.send.bind(owner.webContents);
    owner.webContents.send = (channel, payload, ...rest) => {
      if (channel === "netcatty:plugins:host-ui-update") {
        validatePluginMutationBatch(payload.mutations);
        updates.push(payload);
      } else if (channel === "netcatty:plugins:host-interaction" && payload?.request?.kind === "vault.selectHosts") {
        setTimeout(() => {
          service.interactionService.respond(owner.webContents, {
            requestId: payload.requestId,
            actionToken: payload.actionToken,
            action: "submit",
            resources: [mockHostRecord],
          }).catch((err) => console.error("INTERACTION_RESPOND_ERR:", err));
        }, 10);
      }
      return origSend(channel, payload, ...rest);
    };

    const instanceId = "monitor-smoke-1";
    const opened = await service.hostDrawnViewHost.open(
      {
        instanceId,
        viewId: "com.binaricat.netcatty-monitor.workbench",
        scopeId: "vault:smoke",
        context: {},
      },
      owner.webContents,
    );
    assert.equal(opened.instanceId, instanceId);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && updates.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(updates.length > 0, "Monitor plugin failed to emit initial host-ui-update within 10s");

    const first = updates[0];
    assert.equal(first.viewId, "com.binaricat.netcatty-monitor.workbench");
    assert.ok(typeof first.css === "string" && first.css.length > 1000 && first.css.length < 128 * 1024);

    // Verify package brand icon PNG + monochrome KPI SVG icon decode through host ViewResourceService
    const iconResult = await service.hostDrawnViewHost.resource(instanceId, "assets/plugin-icon-dark.png", owner.webContents);
    assert.ok(typeof iconResult?.url === "string" && iconResult.url.startsWith("data:image/png;base64,"));
    const kpiIconResult = await service.hostDrawnViewHost.resource(instanceId, "assets/ui/hosts.svg", owner.webContents);
    assert.ok(typeof kpiIconResult?.url === "string" && kpiIconResult.url.startsWith("data:image/png;base64,"));

    // Click "+ Add Hosts" inside the mounted Monitor workbench to trigger durable selectHosts + live SSH exec + PluginMetricChart
    const addHostsButtonId =
      findButtonIdInMutations(updates, "Add Hosts") ||
      findButtonIdInMutations(updates, "Select Vault Hosts") ||
      findButtonIdInMutations(updates, "添加主机");
    assert.ok(addHostsButtonId, "Could not locate Add Hosts button in initial Remote DOM mutations");

    // Wait briefly for initial storage hydration so panel state is ready
    await new Promise((r) => setTimeout(r, 250));
    await service.hostDrawnViewHost.event(instanceId, { type: "click", nodeId: addHostsButtonId }, owner.webContents);

    // Wait for durable binding + vault.execHostCommand + PluginMetricChart (poll 1)
    const execDeadline = Date.now() + 8000;
    let sawMetricChart = false;
    let sawLiveHost = false;
    while (Date.now() < execDeadline) {
      const joined = flattenStrings(updates.map((u) => u.mutations)).join(" ");
      sawMetricChart = joined.includes("metric-chart");
      sawLiveHost = joined.includes("prod-smoke-01") && joined.includes("Ubuntu 24.04");
      if (sawMetricChart && sawLiveHost && execCount >= 2) break;
      await new Promise((r) => setTimeout(r, 80));
    }

    assert.ok(execCount >= 2, `Expected live vault.execHostCommand calls (primary + disk/gpu), got ${execCount}`);
    assert.equal(sawMetricChart, true, "Expected PluginMetricChart ('metric-chart') widget in live host mutations");
    assert.equal(sawLiveHost, true, "Expected live parsed host telemetry ('prod-smoke-01' / 'Ubuntu 24.04') in host mutations");

    // Default hysteresis (consecutivePolls = 2) suppresses a single latency spike; trigger Refresh for poll 2
    const refreshButtonId =
      findButtonIdInMutations(updates, "Refresh") || findButtonIdInMutations(updates, "刷新");
    assert.ok(refreshButtonId, "Could not locate Refresh button in Remote DOM mutations");
    const execCountBeforeRefresh = execCount;
    await service.hostDrawnViewHost.event(instanceId, { type: "click", nodeId: refreshButtonId }, owner.webContents);

    const badgeDeadline = Date.now() + 8000;
    let liveBadge = null;
    while (Date.now() < badgeDeadline) {
      const badges = service.viewBadgeService?.listBadges?.() ?? [];
      liveBadge = badges.find((b) => b.viewId === "com.binaricat.netcatty-monitor.workbench") ?? null;
      if (execCount > execCountBeforeRefresh && liveBadge && liveBadge.count >= 1) break;
      await new Promise((r) => setTimeout(r, 80));
    }

    assert.ok(execCount > execCountBeforeRefresh, `Expected 2nd poll after Refresh click, execCount stayed at ${execCount}`);
    assert.ok(liveBadge && liveBadge.count >= 1 && liveBadge.tone === "warning", `Expected live sidebar badge via views.setBadge after 2 consecutive breaches, got: ${JSON.stringify(liveBadge)}`);

    await service.hostDrawnViewHost.close(instanceId, owner.webContents, "smoke-complete");
    await new Promise((r) => setTimeout(r, 150));
    const badgesAfterClose = service.viewBadgeService?.listBadges?.() ?? [];
    const remainingBadge = badgesAfterClose.find((b) => b.viewId === "com.binaricat.netcatty-monitor.workbench") ?? null;
    assert.equal(remainingBadge, null, `Expected sidebar badge to clear on view close, got: ${JSON.stringify(remainingBadge)}`);
    owner.destroy();
    await service.manager.shutdown();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

    console.log(
      JSON.stringify({
        status: "MONITOR_ELECTRON_SMOKE_OK",
        pluginId: installed.manifest.id,
        version: installed.manifest.version,
        updatesReceived: updates.length,
        canonicalCssBytes: first.css.length,
        iconDecoded: true,
        sshExecCalls: execCount,
        sawMetricChart,
        sawLiveHost,
        liveBadgeCount: liveBadge.count,
        liveBadgeTone: liveBadge.tone,
        badgeClearedOnClose: true,
      }),
    );
    electron.app.exit(0);
  })
  .catch((error) => {
    console.error("MONITOR_ELECTRON_SMOKE_FAILED:", error);
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {}
    electron.app.exit(1);
  });
