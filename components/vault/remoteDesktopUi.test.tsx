import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider";
import {
  DEFAULT_JUMPSERVER_RDP_LAUNCH_MODE,
  isJumpServerRdpLaunchMode,
} from "../../application/state/settingsStorageSync";
import {
  getVaultImportPickerMode,
  selectVaultImportFiles,
} from "../../application/state/vaultImportSelection";
import {
  applyHostDefaultConnectProtocol,
  buildHostForProtocolOverride,
  getHostEnabledProtocols,
  resolveHostDefaultConnectProtocol,
  shouldPromptHostProtocolOnConnect,
} from "../../domain/remoteDesktop";
import type { Host } from "../../types";
import { HostDetailsConnectionSections } from "../HostDetailsConnectionSections";
import { CompanionRemoteDesktopInlineFields, CompanionRemoteDesktopSections } from "../host-details/CompanionRemoteDesktopSections";
import {
  resolvePrimaryProtocolSavePort,
  resolvePrimaryProtocolSwitchPort,
} from "../HostDetailsPanel.helpers";
import {
  getProtocolBadgeClass,
  getProtocolBadgeLabel,
  PROTOCOL_VISUAL_STYLES,
} from "../protocolVisuals";
import QuickConnectWizard from "../QuickConnectWizard";
import { TooltipProvider } from "../ui/tooltip";
import { matchesVaultHostSearch } from "./useVaultHostCollections";

const makeHost = (overrides: Partial<Host>): Host => ({
  id: "h-1",
  label: "Host 1",
  hostname: "10.0.0.10",
  port: 22,
  username: "root",
  tags: [],
  os: "linux",
  protocol: "ssh",
  ...overrides,
});

test("protocolVisuals exposes rdp and vnc styles and badges", () => {
  assert.equal(getProtocolBadgeLabel("rdp"), "RDP");
  assert.equal(getProtocolBadgeLabel("vnc"), "VNC");
  assert.match(getProtocolBadgeClass("rdp"), /blue/);
  assert.match(getProtocolBadgeClass("vnc"), /teal/);
  assert.ok(PROTOCOL_VISUAL_STYLES.rdp.icon);
  assert.ok(PROTOCOL_VISUAL_STYLES.vnc.icon);
});

test("matchesVaultHostSearch supports proto:rdp and proto:vnc for standalone and companion hosts", () => {
  const sshOnly = makeHost({ id: "ssh", label: "Web SSH", hostname: "10.0.0.1" });
  const standaloneRdp = makeHost({
    id: "rdp",
    label: "Windows DC",
    hostname: "10.0.0.2",
    protocol: "rdp",
    port: 3389,
    os: "windows",
  });
  const standaloneVnc = makeHost({
    id: "vnc",
    label: "Mac Mini",
    hostname: "10.0.0.3",
    protocol: "vnc",
    port: 5900,
    username: "",
  });
  const sshWithCompanion = makeHost({
    id: "combo",
    label: "Linux Workstation",
    hostname: "10.0.0.4",
    protocol: "ssh",
    vncConfig: { enabled: true, port: 5901, tunnelViaHostSsh: true },
    rdpConfig: { enabled: true, port: 3389, tunnelViaHostSsh: true },
  });

  assert.equal(matchesVaultHostSearch(sshOnly, "proto:rdp"), false);
  assert.equal(matchesVaultHostSearch(standaloneRdp, "proto:rdp"), true);
  assert.equal(matchesVaultHostSearch(standaloneVnc, "proto:rdp"), false);
  assert.equal(matchesVaultHostSearch(sshWithCompanion, "proto:rdp"), true);

  assert.equal(matchesVaultHostSearch(sshOnly, "proto:vnc"), false);
  assert.equal(matchesVaultHostSearch(standaloneVnc, "proto:vnc"), true);
  assert.equal(matchesVaultHostSearch(standaloneRdp, "proto:vnc"), false);
  assert.equal(matchesVaultHostSearch(sshWithCompanion, "proto:vnc"), true);

  assert.equal(matchesVaultHostSearch(standaloneRdp, "proto:rdp Windows"), true);
  assert.equal(matchesVaultHostSearch(standaloneRdp, "proto:rdp Linux"), false);
});

test("resolvePrimaryProtocolSwitchPort and SavePort handle RDP 3389 and VNC 5900", () => {
  assert.equal(resolvePrimaryProtocolSwitchPort(22, "rdp", false, false), 3389);
  assert.equal(resolvePrimaryProtocolSwitchPort(3389, "vnc", false, false), 5900);
  assert.equal(resolvePrimaryProtocolSwitchPort(5900, "ssh", false, false), 22);
  assert.equal(resolvePrimaryProtocolSwitchPort(33890, "rdp", false, false), 33890);

  assert.equal(resolvePrimaryProtocolSavePort("rdp", undefined, true, false), 3389);
  assert.equal(resolvePrimaryProtocolSavePort("vnc", undefined, true, false), 5900);
  assert.equal(resolvePrimaryProtocolSavePort("rdp", 33890, false, false), 33890);
});

test("HostDetailsConnectionSections trims SSH-only fields for standalone RDP and VNC", () => {
  const renderFor = (overrides: Partial<Host>) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <HostDetailsConnectionSections
          t={(key: string) => key}
          form={makeHost(overrides)}
          setForm={() => {}}
          update={() => {}}
          effectiveAuthMethod="password"
          effectiveUsername=""
          identities={[]}
          identitySuggestionsOpen={false}
          filteredIdentitySuggestions={[]}
          setIdentitySuggestionsOpen={() => {}}
          availableKeys={[]}
          applyIdentity={() => {}}
          showPassword={false}
          setShowPassword={() => {}}
          pendingReferenceKeyPath={null}
          setPendingReferenceKeyPath={() => {}}
          selectedCredentialType={null}
          setSelectedCredentialType={() => {}}
          credentialPopoverOpen={false}
          setCredentialPopoverOpen={() => {}}
          keysByCategory={{ key: [], certificate: [] }}
          newKeyFilePath=""
          setNewKeyFilePath={() => {}}
          addLocalKeyFilePath={() => {}}
          distroOptions={[]}
          effectiveFormDistro={undefined}
          getDistroOptionLabel={() => ""}
        />
      </TooltipProvider>,
    );

  const rdpMarkup = renderFor({ protocol: "rdp", port: 3389, os: "windows", username: "admin" });
  assert.match(rdpMarkup, /hostDetails\.rdp\.portLabel/);
  assert.match(rdpMarkup, /hostDetails\.rdp\.domainPlaceholder/);
  assert.doesNotMatch(rdpMarkup, /hostDetails\.section\.sftp/);
  assert.doesNotMatch(rdpMarkup, /hostDetails\.auth\.mfaFirst/);

  const vncMarkup = renderFor({ protocol: "vnc", port: 5901, username: "" });
  assert.match(vncMarkup, /hostDetails\.vnc\.portLabel/);
  assert.match(vncMarkup, /:1/);
  assert.match(vncMarkup, /hostDetails\.vnc\.usernamePlaceholder/);
  assert.doesNotMatch(vncMarkup, /hostDetails\.section\.sftp/);

  const telnetMarkup = renderFor({
    protocol: "telnet",
    port: 23,
    telnetPort: 2323,
    telnetEnabled: true,
    telnetUsername: "admin",
  });
  assert.match(telnetMarkup, /hostDetails\.telnetOn/);
  assert.match(telnetMarkup, /value="2323"/);
  assert.match(telnetMarkup, /value="admin"/);
  assert.doesNotMatch(telnetMarkup, /hostDetails\.section\.sftp/);
  assert.doesNotMatch(telnetMarkup, /hostDetails\.auth\.method/);
});

test("CompanionRemoteDesktopSections renders enabled companion VNC and RDP collapsed by default without duplicate default switches", () => {
  const host = makeHost({
    protocol: "ssh",
    vncConfig: { enabled: true, port: 5901, tunnelViaHostSsh: true },
    rdpConfig: { enabled: true, port: 3390, tunnelViaHostSsh: true },
  });
  const markup = renderToStaticMarkup(
    <CompanionRemoteDesktopSections
      form={host}
      setForm={() => {}}
      identities={[]}
      t={(key: string) => key}
    />,
  );
  assert.match(markup, /aria-expanded="false"[^>]*>.*?:5901/);
  assert.match(markup, /aria-expanded="false"[^>]*>.*?:3390/);
  assert.doesNotMatch(markup, /hostDetails\.companion\.setDefaultVnc/);
  assert.doesNotMatch(markup, /hostDetails\.companion\.setDefaultRdp/);
});

test("QuickConnectWizard exposes RDP and VNC cards and respects URI target protocol", () => {
  const rdpMarkup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "win.internal", protocol: "rdp", port: 33890, domain: "CORP" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(rdpMarkup, /aria-pressed="true"[^>]*data-protocol="rdp"/);
  assert.match(rdpMarkup, /data-protocol="vnc"/);
  assert.match(rdpMarkup, /Connect to win\.internal:33890/);
});

test("vaultImportSelection allows selecting multiple .rdp files", () => {
  assert.deepEqual(getVaultImportPickerMode("rdp"), {
    directory: false,
    multiple: true,
  });
  const f1 = new File(["full address:s:a"], "a.rdp");
  const f2 = new File(["full address:s:b"], "b.rdp");
  assert.equal(selectVaultImportFiles("rdp", [f1, f2]).length, 2);
});

test("resolveHostDefaultConnectProtocol honors companion defaultConnect while preserving SSH host identity", () => {
  assert.equal(resolveHostDefaultConnectProtocol(makeHost({ protocol: "ssh" })), "ssh");
  assert.equal(resolveHostDefaultConnectProtocol(makeHost({ protocol: "rdp" })), "rdp");
  assert.equal(resolveHostDefaultConnectProtocol(makeHost({ protocol: "vnc" })), "vnc");
  assert.equal(resolveHostDefaultConnectProtocol(makeHost({ protocol: "telnet" })), "telnet");
  assert.equal(
    resolveHostDefaultConnectProtocol(
      makeHost({ protocol: "ssh", vncConfig: { enabled: true, defaultConnect: true } }),
    ),
    "vnc",
  );
  assert.equal(
    resolveHostDefaultConnectProtocol(
      makeHost({ protocol: "ssh", rdpConfig: { enabled: true, defaultConnect: true } }),
    ),
    "rdp",
  );
});

test("JumpServer RDP launch mode setting defaults to builtin and validates values", () => {
  assert.equal(DEFAULT_JUMPSERVER_RDP_LAUNCH_MODE, "builtin");
  assert.equal(isJumpServerRdpLaunchMode("builtin"), true);
  assert.equal(isJumpServerRdpLaunchMode("system"), true);
  assert.equal(isJumpServerRdpLaunchMode("invalid"), false);
});

test("shouldPromptHostProtocolOnConnect preserves legacy defaults and honors ask/default", () => {
  // Single-protocol hosts never prompt even if connectProtocolBehavior is set
  assert.equal(
    shouldPromptHostProtocolOnConnect(makeHost({ protocol: "ssh", connectProtocolBehavior: "ask" })),
    false,
  );
  // Legacy SSH + Telnet prompts by default
  assert.equal(
    shouldPromptHostProtocolOnConnect(makeHost({ protocol: "ssh", telnetEnabled: true })),
    true,
  );
  // Explicit default suppresses legacy SSH + Telnet prompt
  assert.equal(
    shouldPromptHostProtocolOnConnect(
      makeHost({ protocol: "ssh", telnetEnabled: true, connectProtocolBehavior: "default" }),
    ),
    false,
  );
  // Legacy SSH + RDP does NOT prompt unless user explicitly selects ask
  assert.equal(
    shouldPromptHostProtocolOnConnect(makeHost({ protocol: "ssh", rdpConfig: { enabled: true } })),
    false,
  );
  assert.equal(
    shouldPromptHostProtocolOnConnect(
      makeHost({
        protocol: "ssh",
        rdpConfig: { enabled: true },
        connectProtocolBehavior: "ask",
      }),
    ),
    true,
  );
});

test("applyHostDefaultConnectProtocol preserves SSH when setting Telnet default and round-trips", () => {
  const sshTelnet = makeHost({ protocol: "ssh", port: 2222, telnetEnabled: true, telnetPort: 2323 });
  const telnetDefault = applyHostDefaultConnectProtocol(sshTelnet, "telnet");
  assert.equal(telnetDefault.protocol, "telnet");
  assert.equal(telnetDefault.connectProtocolBehavior, "default");
  assert.deepEqual(getHostEnabledProtocols(telnetDefault), ["ssh", "telnet"]);

  const backToSsh = applyHostDefaultConnectProtocol(telnetDefault, "ssh");
  assert.equal(backToSsh.protocol, "ssh");
  assert.equal(backToSsh.port, 2222);
  assert.equal(backToSsh.telnetEnabled, true);
  assert.deepEqual(getHostEnabledProtocols(backToSsh), ["ssh", "telnet"]);
});

test("buildHostForProtocolOverride keeps SSH identity for companion RDP/VNC and clears defaultConnect for SSH", () => {
  const host = makeHost({
    protocol: "ssh",
    port: 2222,
    rdpConfig: { enabled: true, port: 3389, tunnelViaHostSsh: true, defaultConnect: true },
  });

  const rdpDispatch = buildHostForProtocolOverride(host, "rdp", 13389);
  assert.equal(rdpDispatch.mode, "remoteDesktop");
  if (rdpDispatch.mode === "remoteDesktop") {
    assert.equal(rdpDispatch.protocol, "rdp");
    assert.equal(rdpDispatch.host.protocol, "ssh");
    assert.equal(rdpDispatch.host.port, 2222);
    assert.equal(rdpDispatch.host.rdpConfig?.port, 13389);
    assert.equal(rdpDispatch.host.rdpConfig?.tunnelViaHostSsh, true);
  }

  const sshDispatch = buildHostForProtocolOverride(host, "ssh", 2222);
  assert.equal(sshDispatch.mode, "connect");
  assert.equal(sshDispatch.host.protocol, "ssh");
  assert.equal(sshDispatch.host.rdpConfig?.defaultConnect, undefined);
});

for (const resolutionMode of ["fixed", "dynamic", "fit"] as const) {
  test(`companion RDP shows dimensions only in fixed mode: ${resolutionMode}`, () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <CompanionRemoteDesktopInlineFields
          protocol="rdp"
          form={makeHost({ rdpConfig: { enabled: true, resolutionMode, width: 1920, height: 1080 } })}
          setForm={() => {}}
          identities={[]}
          t={(key) => key}
        />
      </TooltipProvider>,
    );
    for (const dimension of ["width", "height"]) {
      const label = new RegExp(`hostDetails\\.rdp\\.${dimension}`);
      if (resolutionMode === "fixed") assert.match(markup, label);
      else assert.doesNotMatch(markup, label);
    }
    if (resolutionMode === "fixed") {
      assert.match(markup, /inputMode="numeric"[^>]*value="1920"/);
      assert.match(markup, /inputMode="numeric"[^>]*value="1080"/);
    }
  });
}
