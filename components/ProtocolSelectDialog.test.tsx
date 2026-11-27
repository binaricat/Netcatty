import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../application/i18n/I18nProvider";
import type { Host } from "../types";
import ProtocolSelectDialog from "./ProtocolSelectDialog";
import {
  PROTOCOL_OPTION_CARD_IDLE_CLASS,
  PROTOCOL_OPTION_CARD_SELECTED_CLASS,
  PROTOCOL_VISUAL_STYLES,
} from "./protocolVisuals";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "prod-db",
  hostname: "10.2.0.31",
  port: 22,
  username: "root",
  protocol: "ssh",
  moshEnabled: true,
  etEnabled: true,
  telnetEnabled: true,
  ...overrides,
});

test("protocol select dialog restores host label and shared protocol visuals", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <ProtocolSelectDialog
        host={host()}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Connect to prod-db/);
  assert.match(markup, /10\.2\.0\.31:22/);
  assert.match(markup, /lucide-plug/);
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.ssh.selected.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.mosh.idle.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.et.idle.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.telnet.idle.replace("/", "\\/")));
  assert.match(markup, /lucide-shield/);
  assert.match(markup, /lucide-radio/);
  assert.match(markup, /lucide-link-2/);
  assert.match(markup, /lucide-terminal/);
});

test("plugin protocol hosts default to the plugin provider when optional built-in protocols exist", () => {
  const providerId = "com.example.transport.connection";
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <ProtocolSelectDialog
        host={host({
          protocol: `plugin:${providerId}`,
          pluginConnection: {
            providerId,
            configuration: { endpoint: "opaque-target" },
          },
          protocols: [{ protocol: "telnet", port: 2323, enabled: true }],
          telnetEnabled: true,
        })}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />
    </I18nProvider>,
  );

  assert.ok(markup.indexOf(providerId) < markup.indexOf(">Telnet<"));
  const providerStart = markup.lastIndexOf("<button", markup.indexOf(providerId));
  const providerEnd = markup.indexOf("</button>", markup.indexOf(providerId));
  const providerButton = markup.slice(providerStart, providerEnd);
  assert.match(providerButton, /aria-pressed="true"/);
  assert.match(providerButton, /data-state="active"/);
  for (const token of PROTOCOL_OPTION_CARD_SELECTED_CLASS.split(/\s+/)) {
    assert.ok(providerButton.includes(token), `expected active plugin protocol card to include ${token}`);
  }
  assert.doesNotMatch(providerButton, /type="number"/);
  assert.equal((markup.match(/type="number"/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /10\.2\.0\.31:22/);

  const telnetStart = markup.lastIndexOf("<button", markup.indexOf(">Telnet<"));
  const telnetEnd = markup.indexOf("</button>", markup.indexOf(">Telnet<"));
  const telnetButton = markup.slice(telnetStart, telnetEnd);
  assert.match(telnetButton, /aria-pressed="false"/);
  assert.match(telnetButton, /data-state="inactive"/);
  for (const token of PROTOCOL_OPTION_CARD_IDLE_CLASS.split(/\s+/)) {
    assert.ok(telnetButton.includes(token), `expected idle Telnet card to include ${token}`);
  }
  assert.ok(!telnetButton.includes("border-primary"));
});

test("protocol select dialog lists companion RDP and VNC protocols with remember-default toggle", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <ProtocolSelectDialog
        host={host({
          moshEnabled: false,
          etEnabled: false,
          telnetEnabled: false,
          rdpConfig: { enabled: true, port: 13389, tunnelViaHostSsh: true, defaultConnect: true },
          vncConfig: { enabled: true, port: 5902, tunnelViaHostSsh: false },
          connectProtocolBehavior: "ask",
        })}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /data-protocol="ssh"/);
  assert.match(markup, /data-protocol="rdp"/);
  assert.match(markup, /data-protocol="vnc"/);
  assert.match(markup, /via SSH/);
  assert.match(markup, /13389/);
  assert.match(markup, /5902/);
  assert.match(markup, /Remember as default/);
  // RDP is flagged defaultConnect, so it is pre-selected in the dialog
  const rdpStart = markup.lastIndexOf("<button", markup.indexOf('data-protocol="rdp"'));
  const rdpEnd = markup.indexOf("</button>", markup.indexOf('data-protocol="rdp"'));
  assert.match(markup.slice(rdpStart, rdpEnd), /aria-pressed="true"/);
});
