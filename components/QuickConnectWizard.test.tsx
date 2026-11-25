import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compile } from "@tailwindcss/node";
import postcss from "postcss";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../application/i18n/I18nProvider";
import QuickConnectWizard from "./QuickConnectWizard";
import {
  PROTOCOL_OPTION_CARD_IDLE_CLASS,
  PROTOCOL_OPTION_CARD_SELECTED_CLASS,
  PROTOCOL_OPTION_TITLE_IDLE_CLASS,
  PROTOCOL_OPTION_TITLE_SELECTED_CLASS,
  PROTOCOL_VISUAL_STYLES,
} from "./protocolVisuals";

test("QuickConnectWizard offers ET without obsolete Mosh path or log controls", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "example.com" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Eternal Terminal/);
  assert.doesNotMatch(markup, /mosh --server/);
  assert.doesNotMatch(markup, /Show logs|Hide logs/);
});

test("quick connect shows saved identities as credential presets", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "192.0.2.10" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Credential preset/);
  assert.match(markup, /Choose a saved identity/);
});

test("quick connect protocol step uses simplified connect header and protocol icons", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "10.2.0.31" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Connect to 10\.2\.0\.31:22/);
  assert.match(markup, /lucide-plug/);
  assert.doesNotMatch(markup, />_</);
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.ssh.selected.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.mosh.idle.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.et.idle.replace("/", "\\/")));
  assert.match(markup, new RegExp(PROTOCOL_VISUAL_STYLES.telnet.idle.replace("/", "\\/")));
  assert.match(markup, /lucide-shield/);
  assert.match(markup, /lucide-radio/);
  assert.match(markup, /lucide-link-2/);
  assert.match(markup, /lucide-terminal/);
  assert.match(markup, /text-sm font-medium[^>]*>Choose protocol</);
});

test("quick connect credential section title matches protocol section title style", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "10.2.0.31" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /text-sm font-medium[^>]*>Choose protocol</);
  assert.match(markup, /text-sm font-medium[^>]*>Credential preset</);
});

test("quick connect gives the selected protocol option high-contrast active styling distinct from idle options", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "192.168.1.1" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  const buttonMatches = [...markup.matchAll(/<button[^>]*data-protocol="(ssh|mosh|et|telnet)"[^>]*>[\s\S]*?<\/button>/g)];
  assert.equal(buttonMatches.length, 4);

  const byProtocol = new Map(buttonMatches.map((match) => [match[1], match[0]]));
  const sshButton = byProtocol.get("ssh")!;
  assert.match(sshButton, /aria-pressed="true"/);
  assert.match(sshButton, /data-state="active"/);
  for (const token of PROTOCOL_OPTION_CARD_SELECTED_CLASS.split(/\s+/)) {
    assert.ok(sshButton.includes(token), `expected selected SSH card to include ${token}`);
  }
  assert.ok(sshButton.includes(PROTOCOL_OPTION_TITLE_SELECTED_CLASS));
  assert.ok(!sshButton.includes(PROTOCOL_OPTION_CARD_IDLE_CLASS));

  for (const idleProtocol of ["mosh", "et", "telnet"] as const) {
    const idleButton = byProtocol.get(idleProtocol)!;
    assert.match(idleButton, /aria-pressed="false"/);
    assert.match(idleButton, /data-state="inactive"/);
    for (const token of PROTOCOL_OPTION_CARD_IDLE_CLASS.split(/\s+/)) {
      assert.ok(idleButton.includes(token), `expected idle ${idleProtocol} card to include ${token}`);
    }
    assert.ok(idleButton.includes(PROTOCOL_OPTION_TITLE_IDLE_CLASS));
    assert.ok(!idleButton.includes("border-primary"));
    assert.ok(!idleButton.includes("ring-primary/30"));
  }
});

test("global index.css keeps default border-color in @layer base so border-primary utilities take precedence", async () => {
  const source = await readFile(new URL("../index.css", import.meta.url), "utf8");
  const compiler = await compile(source, { base: path.resolve("."), onDependency() {} });
  const css = compiler.build([
    ...PROTOCOL_OPTION_CARD_SELECTED_CLASS.split(/\s+/),
    ...PROTOCOL_OPTION_CARD_IDLE_CLASS.split(/\s+/),
    "border-2",
  ]);
  const root = postcss.parse(css);

  let foundLayeredDefaultBorder = false;
  let foundUnlayeredUniversalBorder = false;
  let foundBorderPrimaryUtility = false;

  root.walkRules((rule) => {
    const isUniversal = rule.selectors.some((sel) => sel.trim() === "*");
    let layerName: string | null = null;
    let parent: postcss.Node | undefined = rule.parent;
    while (parent) {
      if (parent.type === "atrule" && (parent as postcss.AtRule).name === "layer") {
        layerName = (parent as postcss.AtRule).params.trim();
        break;
      }
      parent = parent.parent;
    }

    rule.walkDecls("border-color", (decl) => {
      if (isUniversal && decl.value.includes("var(--border)")) {
        if (layerName === "base") foundLayeredDefaultBorder = true;
        else foundUnlayeredUniversalBorder = true;
      }
      if (rule.selector.includes(".border-primary") && layerName === "utilities") {
        foundBorderPrimaryUtility = true;
      }
    });
  });

  assert.equal(foundUnlayeredUniversalBorder, false, "unlayered universal border-color would override Tailwind @layer utilities");
  assert.equal(foundLayeredDefaultBorder, true, "default border-color should remain in @layer base");
  assert.equal(foundBorderPrimaryUtility, true, ".border-primary should be generated inside @layer utilities");
});

