import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { GroupConfig, Identity } from "../types.ts";
import GroupDetailsPanel, {
  hasGroupRdpFields,
  hasGroupSshFields,
  hasGroupTelnetFields,
  hasGroupVncFields,
  includeMissingIdentityOption,
  resolveGroupFormIdentityId,
  selectGroupRdpIdentity,
  selectGroupSshIdentity,
  selectGroupTelnetIdentity,
  selectGroupVncIdentity,
} from "./GroupDetailsPanel.tsx";
import { installDomEnvironment } from "./test-support/renderReactDom.tsx";
import { AsidePanelFooter } from "./ui/aside-panel.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

test("GroupDetailsPanel treats an empty SSH identity as an explicit setting", () => {
  assert.equal(hasGroupSshFields({ identityId: "" }), true);
  assert.equal(hasGroupSshFields({}), false);
});

test("GroupDetailsPanel keeps the SSH section when X11 forwarding is set", () => {
  assert.equal(hasGroupSshFields({ x11Forwarding: true }), true);
  assert.equal(hasGroupSshFields({ x11Forwarding: false }), true);
});

test("GroupDetailsPanel treats cleared telnet credentials as explicit settings", () => {
  assert.equal(hasGroupTelnetFields({ telnetUsername: "" }), true);
  assert.equal(hasGroupTelnetFields({ telnetPassword: "" }), true);
  assert.equal(hasGroupTelnetFields({ telnetIdentityId: "identity-1" }), true);
  assert.equal(hasGroupTelnetFields({}), false);
});

test("GroupDetailsPanel replaces manual SSH credentials with a reusable identity", () => {
  const result = selectGroupSshIdentity(
    {
      username: "manual",
      password: "secret",
      identityFileId: "key-1",
      identityFilePaths: ["~/.ssh/id_ed25519"],
    },
    {
      id: "identity-1",
      label: "Shared admin",
      username: "admin",
      authMethod: "password",
      created: 1,
    },
  );

  assert.equal(result.identityId, "identity-1");
  assert.equal(result.username, "admin");
  assert.equal(result.password, undefined);
  assert.equal(result.identityFileId, undefined);
  assert.equal(result.identityFilePaths, undefined);
});

test("GroupDetailsPanel replaces manual Telnet credentials with a reusable identity", () => {
  const result = selectGroupTelnetIdentity(
    { telnetUsername: "manual", telnetPassword: "secret" },
    "identity-1",
  );

  assert.equal(result.telnetIdentityId, "identity-1");
  assert.equal(result.telnetUsername, undefined);
  assert.equal(result.telnetPassword, undefined);
});

test("GroupDetailsPanel explicitly clears inherited identities for manual credentials", () => {
  const ssh = selectGroupSshIdentity({}, undefined, "", "parent-ssh-identity");
  const telnet = selectGroupTelnetIdentity({}, "", "parent-telnet-identity");

  assert.equal(ssh.identityId, "");
  assert.equal(telnet.telnetIdentityId, "");
});

test("GroupDetailsPanel clears key authentication before switching to a manual password", () => {
  const selected = selectGroupSshIdentity(
    {},
    {
      id: "key-identity",
      label: "Key identity",
      username: "admin",
      authMethod: "key",
      keyId: "key-1",
      created: 1,
    },
  );
  const cleared = selectGroupSshIdentity(selected, undefined);
  const manual = { ...cleared, username: "operator", password: "secret" };

  assert.equal(manual.identityId, undefined);
  assert.equal(manual.authMethod, undefined);
  assert.equal(manual.username, "operator");
  assert.equal(manual.password, "secret");
});

test("GroupDetailsPanel keeps a deleted identity visible so it can be cleared", () => {
  const options = includeMissingIdentityOption([], "deleted-identity", "Identity not found");

  assert.deepEqual(options, [{ value: "deleted-identity", label: "Identity not found" }]);
});

test("GroupDetailsPanel shows saved child manual credentials instead of a parent identity", () => {
  assert.equal(
    resolveGroupFormIdentityId(
      { username: "child-user", password: "child-password" },
      "parent-ssh-identity",
      "ssh",
    ),
    undefined,
  );
  assert.equal(
    resolveGroupFormIdentityId(
      { telnetUsername: "child-user", telnetPassword: "child-password" },
      "parent-telnet-identity",
      "telnet",
    ),
    undefined,
  );
  assert.equal(
    resolveGroupFormIdentityId(
      { rdpConfig: { enabled: true, username: "child-rdp-user" } },
      "parent-rdp-identity",
      "rdp",
    ),
    undefined,
  );
  assert.equal(
    resolveGroupFormIdentityId(
      { vncConfig: { enabled: true, useHostCredentials: true } },
      "parent-vnc-identity",
      "vnc",
    ),
    undefined,
  );
});

test("GroupDetailsPanel detects RDP and VNC configs without falsely enabling SSH on RDP-only groups with proxy/chain", () => {
  assert.equal(hasGroupRdpFields({ rdpConfig: { enabled: true } }), true);
  assert.equal(hasGroupRdpFields({}), false);
  assert.equal(hasGroupVncFields({ vncConfig: { enabled: true } }), true);
  assert.equal(hasGroupVncFields({}), false);

  // RDP-only group with proxy/chain stays RDP-only.
  assert.equal(
    hasGroupSshFields({
      rdpConfig: { enabled: true, port: 3389 },
      proxyProfileId: "corp-proxy",
      hostChain: { hostIds: ["bastion-1"] },
    }),
    false,
  );
  // Legacy group with only proxy/chain still shows SSH enabled.
  assert.equal(hasGroupSshFields({ proxyProfileId: "corp-proxy" }), true);
});

test("GroupDetailsPanel selects and clears RDP and VNC identities cleanly", () => {
  const identity: Identity = {
    id: "win-admin",
    label: "Windows Admin",
    username: "Administrator",
    domain: "CORP",
    authMethod: "password",
    password: "secret",
    created: 1,
  };

  const withRdp = selectGroupRdpIdentity({}, identity, identity.id);
  assert.equal(withRdp.rdpConfig?.identityId, "win-admin");
  assert.equal(withRdp.rdpConfig?.domain, "CORP");
  assert.equal(withRdp.rdpConfig?.useHostCredentials, false);

  const clearedRdp = selectGroupRdpIdentity({}, undefined, "", "parent-rdp-id");
  assert.equal(clearedRdp.rdpConfig?.identityId, "");

  const withVnc = selectGroupVncIdentity({}, identity, identity.id);
  assert.equal(withVnc.vncConfig?.identityId, "win-admin");
  assert.equal(withVnc.vncConfig?.useHostCredentials, false);

  const clearedVnc = selectGroupVncIdentity({}, undefined, "", "parent-vnc-id");
  assert.equal(clearedVnc.vncConfig?.identityId, "");
});

test("GroupDetailsPanel unifies 4-protocol tabs, adds RDP/VNC defaults, and saves via footer without plaintext passwords", async () => {
  const dom = installDomEnvironment();
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let renderer: ReactTestRenderer | undefined;
  let savedConfig: GroupConfig | undefined;
  const createdIdentities: Identity[] = [];

  try {
    await act(async () => {
      renderer = create(
        <I18nProvider locale="en">
          <TooltipProvider>
            <GroupDetailsPanel
              groupPath="Windows"
              config={undefined}
              availableKeys={[]}
              identities={[]}
              onCreateIdentity={(identity) => createdIdentities.push(identity)}
              allHosts={[]}
              groups={["Windows"]}
              terminalThemeId="default"
              terminalFontSize={14}
              layout="inline"
              onSave={(value) => {
                savedConfig = value;
              }}
              onCancel={() => {}}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    const protocolTabs = renderer!.root.findAll(
      (node) => node.type === "button" && typeof node.props["data-group-protocol"] === "string",
    );
    assert.deepEqual(
      protocolTabs.map((node) => node.props["data-group-protocol"]),
      ["ssh", "rdp", "vnc", "telnet"],
    );

    const collectText = (node: unknown): string => {
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map(collectText).join("");
      if (node && typeof node === "object" && "children" in node) {
        return collectText((node as { children: unknown }).children);
      }
      return "";
    };
    const buttonText = (btn: { children: unknown[] }) => collectText(btn.children);

    // Switch to RDP tab and enable RDP
    const rdpTab = protocolTabs.find((node) => node.props["data-group-protocol"] === "rdp")!;
    await act(async () => {
      rdpTab.props.onClick();
    });
    const addRdpBtn = renderer!.root.findAllByType(Button).find((btn) =>
      buttonText(btn).includes("Add RDP"),
    );
    assert.ok(addRdpBtn, "expected Add RDP button when RDP is not enabled");
    await act(async () => {
      addRdpBtn.props.onClick();
    });

    // Set RDP port, domain, username, and password (password must become a Keychain identity)
    const rdpPortInput = renderer!.root.findAllByType(Input).find(
      (input) => input.props.placeholder === "3389",
    );
    const rdpDomainInput = renderer!.root.findAllByType(Input).find(
      (input) => input.props.placeholder === "CORP (optional)",
    );
    const rdpUserInput = renderer!.root.findAllByType(Input).find(
      (input) => typeof input.props.placeholder === "string" && input.props.placeholder.includes("DOMAIN"),
    );
    const rdpPasswordInput = renderer!.root.findAllByType(Input).find(
      (input) => input.props.type === "password",
    );
    assert.ok(rdpPortInput && rdpDomainInput && rdpUserInput && rdpPasswordInput);
    await act(async () => {
      rdpPortInput.props.onChange({ target: { value: "13389" } });
      rdpDomainInput.props.onChange({ target: { value: "CORP" } });
      rdpUserInput.props.onChange({ target: { value: "admin" } });
      rdpPasswordInput.props.onChange({ target: { value: "rdp-secret" } });
    });

    // Switch to VNC tab and enable VNC with :2 display port
    const vncTab = renderer!.root.findAll(
      (node) => node.type === "button" && node.props["data-group-protocol"] === "vnc",
    )[0];
    await act(async () => {
      vncTab.props.onClick();
    });
    const addVncBtn = renderer!.root.findAllByType(Button).find((btn) =>
      buttonText(btn).includes("Add VNC"),
    );
    assert.ok(addVncBtn, "expected Add VNC button when VNC is not enabled");
    await act(async () => {
      addVncBtn.props.onClick();
    });
    const vncPortInput = renderer!.root.findAllByType(Input).find(
      (input) => input.props.placeholder === "5900 or :0",
    );
    assert.ok(vncPortInput);
    await act(async () => {
      vncPortInput.props.onChange({ target: { value: ":2" } });
    });

    // Save via the unified AsidePanelFooter Save button
    const footerSaveBtn = renderer!.root.findByType(AsidePanelFooter).findByType(Button);
    await act(async () => {
      footerSaveBtn.props.onClick();
    });

    assert.ok(savedConfig, "expected GroupDetailsPanel footer save button to emit GroupConfig");
    assert.equal(savedConfig.protocol, undefined, "SSH should remain disabled");
    assert.equal(createdIdentities.length, 1);
    assert.equal(createdIdentities[0].username, "admin");
    assert.equal(createdIdentities[0].domain, "CORP");
    assert.equal(createdIdentities[0].password, "rdp-secret");
    assert.equal(savedConfig.rdpConfig?.enabled, true);
    assert.equal(savedConfig.rdpConfig?.port, 13389);
    assert.equal(savedConfig.rdpConfig?.domain, "CORP");
    assert.equal(savedConfig.rdpConfig?.identityId, createdIdentities[0].id);
    assert.equal("password" in (savedConfig.rdpConfig ?? {}), false);
    assert.equal(savedConfig.vncConfig?.enabled, true);
    assert.equal(savedConfig.vncConfig?.port, 5902);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
    dom.cleanup();
  }
});
