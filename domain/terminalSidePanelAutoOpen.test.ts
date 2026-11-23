import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS,
  isNetworkDeviceAutoOpenTarget,
  resolveTerminalSidePanelAutoOpen,
  resolveSessionSidePanelAutoOpen,
  shouldAutoOpenSftpForHost,
  type TerminalSidePanelAutoOpenTab,
} from "./terminalSidePanelAutoOpen.ts";
import { TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER } from "../application/state/terminalSidePanelTabs.ts";

test("terminal side panel auto-open stays off by default", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: false,
      selectedTab: "scripts",
      sftpAvailable: true,
    }),
    null,
  );
});

test("terminal side panel auto-open returns the selected non-SFTP pane", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: true,
      selectedTab: "scripts",
      sftpAvailable: false,
    }),
    "scripts",
  );
});

test("terminal side panel auto-open skips SFTP when the session cannot use it", () => {
  assert.equal(
    resolveTerminalSidePanelAutoOpen({
      enabled: true,
      selectedTab: "sftp",
      sftpAvailable: false,
    }),
    null,
  );
});

test("terminal side panel auto-open accepts every selectable side pane", () => {
  const tabs: TerminalSidePanelAutoOpenTab[] = [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];

  assert.deepEqual(TERMINAL_SIDE_PANEL_AUTO_OPEN_TABS, TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);

  assert.deepEqual(
    tabs.map((selectedTab) =>
      resolveTerminalSidePanelAutoOpen({
        enabled: true,
        selectedTab,
        sftpAvailable: true,
      }),
    ),
    tabs,
  );
});

const preferences = {
  terminalEnabled: true,
  terminalTab: "notes" as const,
  localEnabled: true,
  localTab: "sftp" as const,
  legacySftpEnabled: false,
};

test("local sessions use their separate auto-open preference", () => {
  assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, session: { protocol: "local" } }), "sftp");
  assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, localEnabled: false, session: { protocol: "local" } }), null);
});

test("SSH, mosh and legacy sessions use remote preferences", () => {
  for (const protocol of ["ssh", "mosh", undefined] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, session: { protocol } }), "notes");
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: "sftp", localEnabled: false, session: { protocol } }), "sftp");
  }
});

test("legacy SFTP auto-open preserves remote behavior without overriding local opt-out", () => {
  const options = { ...preferences, terminalEnabled: false, localEnabled: false, legacySftpEnabled: true };
  assert.equal(resolveSessionSidePanelAutoOpen({ ...options, session: { protocol: "local" } }), null);
  assert.equal(resolveSessionSidePanelAutoOpen({ ...options, session: { protocol: "ssh" } }), "sftp");
});

test("explicit per-session SFTP requests take priority on supported transports", () => {
  for (const protocol of ["ssh", "mosh", "local", undefined] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, localEnabled: false, session: { protocol, autoOpenSidePanel: "sftp" } }), "sftp");
  }
  for (const protocol of ["serial", "telnet", "plugin:example"] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: "sftp", legacySftpEnabled: true, session: { protocol, autoOpenSidePanel: "sftp" } }), null);
  }
});

test("Browser auto-open skips unsupported terminal protocols", () => {
  for (const protocol of ['ssh', 'mosh', 'local', undefined] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'browser', localTab: 'browser', session: { protocol } }), 'browser');
  }
  for (const protocol of ['telnet', 'serial', 'et', 'plugin:example'] as const) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...preferences, terminalTab: 'browser', session: { protocol } }), null);
  }
});

test("shouldAutoOpenSftpForHost allows regular hosts and blocks network devices by default", () => {
  assert.equal(shouldAutoOpenSftpForHost(undefined), true);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux", distro: "ubuntu" }), true);
  assert.equal(shouldAutoOpenSftpForHost({ os: "macos", distro: "macos" }), true);
  assert.equal(shouldAutoOpenSftpForHost({ os: "windows", distro: "windows" }), true);
  assert.equal(shouldAutoOpenSftpForHost({ deviceType: "general", distro: "debian" }), true);

  assert.equal(shouldAutoOpenSftpForHost({ deviceType: "network", distro: "ubuntu" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "network" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { deviceClass: "network-device" }), false);

  for (const distro of [
    "cisco",
    "juniper",
    "huawei",
    "h3c",
    "hpe",
    "mikrotik",
    "fortinet",
    "paloalto",
    "zyxel",
    "ruijie",
  ]) {
    assert.equal(isNetworkDeviceAutoOpenTarget({ distro }), true, distro);
    assert.equal(shouldAutoOpenSftpForHost({ distro }), false, distro);
  }

  // First-connect banner classification before host.distro is persisted
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { remoteSshVersion: "SSH-2.0-Cisco-1.25" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { remoteSshVersion: "SSH-2.0-Huawei-1.5" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { remoteSshVersion: "SSH-2.0-Comware-7.1" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { remoteSshVersion: "SSH-2.0-ROSSSH" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { remoteSshVersion: "-" }), false);
  assert.equal(shouldAutoOpenSftpForHost({ os: "linux" }, { remoteSshVersion: "SSH-2.0-OpenSSH_9.6" }), true);

  // Explicit per-host or deep-link opt-in overrides default network-device suppression
  assert.equal(shouldAutoOpenSftpForHost({ deviceType: "network", autoOpenSftpPanel: true }), true);
  assert.equal(shouldAutoOpenSftpForHost({ distro: "cisco", autoOpenSftpPanel: true }), true);
  assert.equal(
    shouldAutoOpenSftpForHost({ distro: "huawei" }, { explicitAutoOpen: true, remoteSshVersion: "SSH-2.0-Huawei-1.5" }),
    true,
  );
});

test("resolveSessionSidePanelAutoOpen skips default SFTP on network devices while preserving other tabs and explicit opt-in", () => {
  const sftpByDefault = {
    terminalEnabled: true,
    terminalTab: "sftp" as const,
    localEnabled: false,
    localTab: "scripts" as const,
    legacySftpEnabled: true,
  };
  const legacyOnly = {
    terminalEnabled: false,
    terminalTab: "scripts" as const,
    localEnabled: false,
    localTab: "scripts" as const,
    legacySftpEnabled: true,
  };

  // Regular hosts keep auto-opening SFTP
  for (const host of [
    { os: "linux", distro: "ubuntu" },
    { os: "macos", distro: "macos" },
    { os: "windows", distro: "windows" },
  ]) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...sftpByDefault, session: { protocol: "ssh" }, host }), "sftp");
    assert.equal(resolveSessionSidePanelAutoOpen({ ...legacyOnly, session: { protocol: "ssh" }, host }), "sftp");
  }

  // Network devices skip both terminalTab="sftp" and legacySftpEnabled
  for (const host of [
    { deviceType: "network" as const },
    { distro: "cisco" },
    { distro: "huawei" },
    { distro: "juniper" },
    { distro: "mikrotik" },
    { os: "network" },
  ]) {
    assert.equal(resolveSessionSidePanelAutoOpen({ ...sftpByDefault, session: { protocol: "ssh" }, host }), null);
    assert.equal(resolveSessionSidePanelAutoOpen({ ...legacyOnly, session: { protocol: "ssh" }, host }), null);
  }

  // First-connect SSH vendor banner also skips default SFTP auto-open
  assert.equal(
    resolveSessionSidePanelAutoOpen({
      ...legacyOnly,
      session: { protocol: "ssh" },
      host: { os: "linux" },
      remoteSshVersion: "SSH-2.0-Cisco-1.25",
    }),
    null,
  );

  // Non-SFTP tabs (including browser and scripts) still auto-open on network devices
  assert.equal(
    resolveSessionSidePanelAutoOpen({
      ...preferences,
      terminalTab: "scripts",
      legacySftpEnabled: true,
      session: { protocol: "ssh" },
      host: { deviceType: "network" },
    }),
    "scripts",
  );
  assert.equal(
    resolveSessionSidePanelAutoOpen({
      ...preferences,
      terminalTab: "browser",
      legacySftpEnabled: true,
      session: { protocol: "ssh" },
      host: { deviceType: "network" },
    }),
    "browser",
  );

  // Explicit per-host / deep-link SFTP opt-in still opens SFTP on supported transports
  assert.equal(
    resolveSessionSidePanelAutoOpen({
      ...legacyOnly,
      legacySftpEnabled: false,
      session: { protocol: "ssh" },
      host: { deviceType: "network", autoOpenSftpPanel: true },
    }),
    "sftp",
  );
  assert.equal(
    resolveSessionSidePanelAutoOpen({
      ...legacyOnly,
      legacySftpEnabled: false,
      session: { protocol: "ssh", autoOpenSidePanel: "sftp" },
      host: { distro: "huawei" },
      remoteSshVersion: "SSH-2.0-Huawei-1.5",
    }),
    "sftp",
  );
  // Unsupported transport still blocks even with explicit opt-in
  assert.equal(
    resolveSessionSidePanelAutoOpen({
      ...legacyOnly,
      session: { protocol: "telnet", autoOpenSidePanel: "sftp" },
      host: { deviceType: "network", autoOpenSftpPanel: true },
    }),
    null,
  );
});
