import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { I18nProvider } from "../application/i18n/I18nProvider";
import { applyGroupDefaults } from "../domain/groupConfig";
import type { GroupConfig, Host } from "../domain/models";
import { resolveEffectiveTerminalProtocol } from "../domain/terminalProtocol";
import HostDetailsPanel from "./HostDetailsPanel";
import { ChainPanel } from "./host-details/ChainPanel";
import { HostDetailsOverrideReset } from "./host-details/HostDetailsOverrideReset";
import { HostDetailsSection, HostDetailsSettingRow } from "./host-details/HostDetailsSection";
import { mapTerminalBackspaceInput } from "./terminal/runtime/terminalBackspaceInput";
import { installDomEnvironment } from "./test-support/renderReactDom";
import { AsidePanelFooter } from "./ui/aside-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";
import { TooltipProvider } from "./ui/tooltip";

const host: Host = {
  id: "host-1", label: "Host", hostname: "example.com", username: "root",
  password: "password", authMethod: "password", tags: [], os: "linux",
  protocol: "ssh", group: "network",
};

const panelProps = (groupDefaults: Partial<GroupConfig>, initialData = host) => ({
  initialData, availableKeys: [], identities: [], proxyProfiles: [],
  groups: ["network"], groupConfigs: [{ path: "network", ...groupDefaults }],
  allHosts: [{ ...host, id: "jump-1", label: "Jump", hostname: "jump.example.com" }],
  terminalThemeId: "default", terminalFontSize: 14, layout: "inline" as const,
  onSave: (_value: Host) => {}, onCancel: () => {},
});

async function withPanel(
  groupDefaults: Partial<GroupConfig>,
  run: (editor: { root: ReactTestInstance; save: () => Promise<Host> }) => Promise<void>,
  initialData = host,
) {
  const dom = installDomEnvironment();
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  let renderer: ReactTestRenderer | undefined;
  let saved: Host | undefined;
  try {
    await act(async () => {
      renderer = create(<I18nProvider locale="en"><TooltipProvider>
        <HostDetailsPanel {...panelProps(groupDefaults, initialData)} onSave={(value) => { saved = value; }} />
      </TooltipProvider></I18nProvider>);
    });
    await run({
      root: renderer!.root,
      save: async () => {
        saved = undefined;
        await act(async () => {
          const buttons = renderer!.root.findByType(AsidePanelFooter).findAllByType(Button);
          await buttons[buttons.length - 1].props.onClick();
        });
        assert.ok(saved, "the actual panel save handler must emit a host");
        return saved;
      },
    });
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
    dom.cleanup();
  }
}

function setting(root: ReactTestInstance, label: string) {
  const row = root.findAllByType(HostDetailsSettingRow).find((node) => node.props.label === label);
  assert.ok(row, `expected setting ${label}`);
  return row;
}

function assertInherited(row: ReactTestInstance) {
  assert.ok(row.findAllByType(Badge).some((badge) => badge.props.children === "Inherited from group"));
  assert.equal(row.findAllByType(HostDetailsOverrideReset).length, 0);
}

for (const [key, label] of [["moshEnabled", "Mosh"], ["etEnabled", "EternalTerminal"]] as const) {
  test(`Host Details shows inherited ${label}, saves Off, and resets to the group`, async () => {
    const group = { [key]: true };
    await withPanel(group, async ({ root, save }) => {
      const row = () => setting(root, label);
      assert.equal(row().findByType(Switch).props.checked, true);
      assertInherited(row());
      assert.equal(root.findAllByType(HostDetailsSettingRow).some((node) => node.props.label === "Network Device Mode"), false);
      if (key === "etEnabled") setting(root, "ET server port");

      await act(async () => { row().findByType(Switch).props.onCheckedChange(false); });
      const off = await save();
      assert.equal(off[key], false);
      assert.equal(applyGroupDefaults(off, group)[key], false);
      assert.equal(row().findByType(Switch).props.checked, false);
      assert.equal(row().findAllByType(Badge).length, 0);
      if (key === "etEnabled") {
        assert.equal(root.findAllByType(HostDetailsSettingRow).some((node) => node.props.label === "ET server port"), false);
      }

      const reset = row().findByType(HostDetailsOverrideReset);
      assert.equal(reset.props.label, "Use group");
      await act(async () => { reset.props.onClick(); });
      const inherited = await save();
      assert.equal(inherited[key], undefined);
      assert.equal(applyGroupDefaults(inherited, group)[key], true);
      assert.equal(row().findByType(Switch).props.checked, true);
      assertInherited(row());
    });
  });

  test(`Host Details restores inherited ${label} and disables the competing transport`, async () => {
    const competingKey = key === "moshEnabled" ? "etEnabled" : "moshEnabled";
    const competingLabel = key === "moshEnabled" ? "EternalTerminal" : "Mosh";
    const group = { [key]: true };
    await withPanel(group, async ({ root, save }) => {
      const row = () => setting(root, label);
      assert.equal(row().findByType(Switch).props.checked, false);
      assert.equal(setting(root, competingLabel).findByType(Switch).props.checked, true);

      const reset = row().findByType(HostDetailsOverrideReset);
      assert.equal(reset.props.label, "Use group");
      await act(async () => { reset.props.onClick(); });
      const inherited = await save();
      assert.equal(inherited[key], undefined);
      assert.equal(inherited[competingKey], false);
      assert.equal(row().findByType(Switch).props.checked, true);
      assertInherited(row());
      assert.equal(setting(root, competingLabel).findByType(Switch).props.checked, false);

      const effective = applyGroupDefaults(inherited, group);
      assert.equal(effective[key], true);
      assert.equal(effective[competingKey], false);
      assert.equal(resolveEffectiveTerminalProtocol(effective), key === "moshEnabled" ? "mosh" : "et");
    }, { ...host, [key]: false, [competingKey]: true });
  });
}

test("Host Details device type override can return to the group", async () => {
  const group = { deviceType: "network" as const };
  await withPanel(group, async ({ root, save }) => {
    const row = () => setting(root, "Network Device Mode");
    assert.equal(row().findByType(Switch).props.checked, true);
    assertInherited(row());
    await act(async () => { row().findByType(Switch).props.onCheckedChange(false); });
    assert.equal((await save()).deviceType, "general");
    assert.equal(row().findByType(Switch).props.checked, false);
    await act(async () => { row().findByType(HostDetailsOverrideReset).props.onClick(); });
    const inherited = await save();
    assert.equal(inherited.deviceType, undefined);
    assert.equal(applyGroupDefaults(inherited, group).deviceType, "network");
    assert.equal(row().findByType(Switch).props.checked, true);
    assertInherited(row());
  });
});

test("Host Details backspace shows inherited Ctrl-H and saves explicit DEL or Ctrl-H or inherit", async () => {
  const group = { backspaceBehavior: "ctrl-h" as const };
  await withPanel(group, async ({ root, save }) => {
    const select = () => setting(root, "Backspace Behavior").findByType(Select);
    assert.equal(select().props.value, "ctrl-h");
    assert.ok(root.findAllByType(Badge).some((badge) => badge.props.children === "Inherited from group"));
    await act(async () => { select().props.onValueChange("default"); });
    const del = await save();
    assert.equal(del.backspaceBehavior, "default");
    const reloaded: Host = JSON.parse(JSON.stringify(del));
    assert.equal(mapTerminalBackspaceInput("\x7f", applyGroupDefaults(reloaded, group).backspaceBehavior), "\x7f");
    assert.equal(select().props.value, "default");
    await act(async () => { select().props.onValueChange("ctrl-h"); });
    assert.equal((await save()).backspaceBehavior, "ctrl-h");
    await act(async () => { setting(root, "Backspace Behavior").findByType(HostDetailsOverrideReset).props.onClick(); });
    const inherited = await save();
    assert.equal(inherited.backspaceBehavior, undefined);
    assert.equal(applyGroupDefaults(inherited, group).backspaceBehavior, "ctrl-h");
    assert.equal(select().props.value, "ctrl-h");
    assert.ok(root.findAllByType(Badge).some((badge) => badge.props.children === "Inherited from group"));
  });
});

test("Host Details keeps no-group toggle and Default backspace behavior", async () => {
  await withPanel({}, async ({ root, save }) => {
    const mosh = setting(root, "Mosh");
    assert.equal(mosh.findByType(Switch).props.checked, false);
    assert.equal(mosh.findAllByType(HostDetailsOverrideReset).length, 0);
    await act(async () => { mosh.findByType(Switch).props.onCheckedChange(true); });
    assert.equal((await save()).moshEnabled, true);
    await act(async () => { setting(root, "Mosh").findByType(Switch).props.onCheckedChange(false); });
    assert.equal((await save()).moshEnabled, false);
    assert.equal(setting(root, "Mosh").findAllByType(HostDetailsOverrideReset).length, 0);
    const select = () => setting(root, "Backspace Behavior").findByType(Select);
    await act(async () => { select().props.onValueChange("ctrl-h"); });
    assert.equal((await save()).backspaceBehavior, "ctrl-h");
    await act(async () => { select().props.onValueChange("default"); });
    assert.equal((await save()).backspaceBehavior, undefined);
  });
});

test("Host Details can restore group jump hosts from the empty-override Direct row", async () => {
  const group = { hostChain: { hostIds: ["jump-1"] } };
  await withPanel(group, async ({ root, save }) => {
    const section = () => root.findAllByType(HostDetailsSection).find((node) => node.props.title === "Proxy via Hosts")!;
    await act(async () => { section().findAllByType("button").find((node) => node.props.className?.includes("cursor-pointer"))!.props.onClick(); });
    await act(async () => { root.findByType(ChainPanel).props.onClearChain(); });
    await act(async () => { root.findByType(ChainPanel).props.onBack(); });
    const direct = await save();
    assert.deepEqual(direct.hostChain, { hostIds: [] });
    assert.deepEqual(applyGroupDefaults(direct, group).hostChain, { hostIds: [] });
    assert.ok(section().findAllByType(Badge).some((badge) => badge.props.children === "Direct"));

    const reset = section().findByType(HostDetailsOverrideReset);
    assert.equal(reset.props.label, "Use group");
    await act(async () => { reset.props.onClick(); });
    const inherited = await save();
    assert.equal(inherited.hostChain, undefined);
    assert.deepEqual(applyGroupDefaults(inherited, group).hostChain, group.hostChain);
    assert.ok(section().findAllByType(Badge).some((badge) => badge.props.children === "Inherited from group"));
  });
});

test("Host Details keeps standalone RDP fields sparse so group RDP defaults are inherited on save", async () => {
  const group: Partial<GroupConfig> = {
    rdpConfig: {
      enabled: true,
      port: 13389,
      domain: "CORP",
      securityMode: "nla",
      audioEnabled: false,
    },
  };
  const rdpHost: Host = {
    ...host,
    protocol: "rdp",
    port: undefined,
    username: "",
    password: undefined,
    authMethod: undefined,
    rdpConfig: undefined,
  };
  await withPanel(group, async ({ root, save }) => {
    const securitySelect = root.findAllByType(Select).find((item) => item.props.value === "nla");
    assert.ok(securitySelect, "expected standalone RDP editor to reflect inherited securityMode");
    const saved = await save();
    assert.equal(saved.port, undefined);
    assert.equal(saved.rdpConfig, undefined);
    const effective = applyGroupDefaults(saved, group);
    assert.equal(effective.port, 13389);
    assert.equal(effective.rdpConfig?.domain, "CORP");
    assert.equal(effective.rdpConfig?.securityMode, "nla");
    assert.equal(effective.rdpConfig?.audioEnabled, false);
  }, rdpHost);
});

test("Host Details preserves useHostCredentials fallback when adding companion RDP without group credential defaults", async () => {
  await withPanel({}, async ({ root, save }) => {
    const rdpTab = root.findAll(
      (node) => node.type === "button" && node.props["data-primary-protocol"] === "rdp",
    )[0];
    assert.ok(rdpTab);
    await act(async () => { rdpTab.props.onClick(); });
    const addRdpBtn = root.findAllByType(Button).find((btn) => {
      const collect = (n: unknown): string =>
        typeof n === "string"
          ? n
          : Array.isArray(n)
            ? n.map(collect).join("")
            : n && typeof n === "object" && "children" in n
              ? collect((n as { children: unknown }).children)
              : "";
      return collect(btn.children).includes("Add RDP");
    });
    assert.ok(addRdpBtn);
    await act(async () => { addRdpBtn.props.onClick(); });
    const saved = await save();
    assert.equal(saved.rdpConfig?.enabled, true);
    assert.equal(saved.rdpConfig?.useHostCredentials, true);
  });
});

test("Host Details preserves cleared inherited companion RDP identity across save", async () => {
  const group: Partial<GroupConfig> = {
    rdpConfig: {
      enabled: true,
      identityId: "group-rdp-id",
    },
  };
  const companionHost: Host = {
    ...host,
    rdpConfig: { enabled: true },
  };
  await withPanel(group, async ({ root, save }) => {
    const rdpTab = root.findAll(
      (node) => node.type === "button" && node.props["data-primary-protocol"] === "rdp",
    )[0];
    await act(async () => { rdpTab.props.onClick(); });
    const clearBtn = root.findAllByType(Button).find(
      (btn) => btn.props.size === "icon" && btn.props.className?.includes("h-8 w-8 shrink-0"),
    );
    assert.ok(clearBtn, "expected Clear button on inherited companion RDP identity");
    await act(async () => { clearBtn.props.onClick({ defaultPrevented: false }); });
    const saved = await save();
    assert.equal(saved.rdpConfig?.identityId, "");
    assert.equal(saved.rdpConfig?.useHostCredentials, false);
    const effective = applyGroupDefaults(saved, group);
    assert.equal(effective.rdpConfig?.identityId, "");
  }, companionHost);
});

test("Host Details retains the inherited desktop username and domain when detaching a standalone RDP identity", async () => {
  const dom = installDomEnvironment();
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let renderer: ReactTestRenderer | undefined;
  let saved: Host | undefined;
  const group: Partial<GroupConfig> = {
    rdpConfig: { enabled: true, identityId: "win-admin" },
  };
  const standaloneRdp: Host = {
    ...host,
    protocol: "rdp",
    port: undefined,
    username: "",
    password: undefined,
    authMethod: undefined,
    rdpConfig: undefined,
  };

  try {
    await act(async () => {
      renderer = create(
        <I18nProvider locale="en">
          <TooltipProvider>
            <HostDetailsPanel
              {...panelProps(group, standaloneRdp)}
              identities={[
                {
                  id: "win-admin",
                  label: "Windows Admin",
                  username: "Administrator",
                  domain: "CORP",
                  authMethod: "password",
                  password: "group-secret",
                  created: 1,
                },
              ]}
              onSave={(value) => { saved = value; }}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    const clearBtn = renderer!.root.findAllByType(Button).find(
      (btn) => btn.props.size === "icon" && btn.props.className?.includes("h-8 w-8 shrink-0"),
    );
    assert.ok(clearBtn, "expected Clear button on inherited standalone RDP identity");
    await act(async () => { clearBtn.props.onClick({ defaultPrevented: false }); });

    const buttons = renderer!.root.findByType(AsidePanelFooter).findAllByType(Button);
    await act(async () => { await buttons[buttons.length - 1].props.onClick(); });

    assert.ok(saved);
    assert.equal(saved.identityId, "");
    assert.equal(saved.username, "Administrator");
    assert.equal(saved.rdpConfig?.domain, "CORP");
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
    dom.cleanup();
  }
});
