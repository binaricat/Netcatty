import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { Host } from "../types.ts";
import HostDetailsPanel, { parseOptionalPortInput } from "./HostDetailsPanel.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const hostWithMissingProxyProfile: Host = {
  id: "host-1",
  label: "DB",
  hostname: "db.example.com",
  username: "root",
  tags: [],
  os: "linux",
  port: 22,
  protocol: "ssh",
  authMethod: "password",
  proxyProfileId: "missing-proxy",
  createdAt: 1,
};

const renderHostDetails = (initialData: Host = hostWithMissingProxyProfile) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData,
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: [],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

const findInputByValue = (markup: string, value: string) => {
  const match = markup.match(new RegExp(`<input(?=[^>]*value="${value}")[^>]*>`));
  assert.ok(match, `expected input with value ${value}`);
  return match[0];
};

const classTokens = (markup: string) => {
  const classMatch = markup.match(/class="([^"]*)"/);
  assert.ok(classMatch, "expected class attribute");
  return new Set(classMatch[1].split(/\s+/).filter(Boolean));
};

test("HostDetailsPanel shows a missing saved proxy without undefined fields", () => {
  const markup = renderHostDetails();

  assert.match(markup, /Missing saved proxy/);
  assert.doesNotMatch(markup, /undefined:undefined/);
});

test("HostDetailsPanel keeps explicitly cleared telnet credentials empty", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 23,
    username: "root",
    password: "ssh-password",
    telnetUsername: "",
    telnetPassword: "",
    proxyProfileId: undefined,
  });

  assert.match(markup, /placeholder="Telnet Username"[^>]*value=""/);
  assert.match(markup, /placeholder="Telnet Password"[^>]*value=""/);
  assert.doesNotMatch(markup, /placeholder="Telnet Username"[^>]*value="root"/);
  assert.doesNotMatch(markup, /placeholder="Telnet Password"[^>]*value="ssh-password"/);
});

test("HostDetailsPanel gives the telnet port field the same roomy layout as SSH", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 2325,
    proxyProfileId: undefined,
  });

  const telnetMarkup = markup.slice(markup.indexOf("Telnet on"));
  const wrapperMatch = telnetMarkup.match(/<div class="([^"]*w-1\/2[^"]*)"/);
  assert.ok(wrapperMatch, "expected telnet port wrapper");
  const wrapperClasses = new Set(wrapperMatch[1].split(/\s+/).filter(Boolean));
  assert.ok(wrapperClasses.has("ml-auto"));
  assert.ok(wrapperClasses.has("w-1/2"));
  assert.ok(wrapperClasses.has("min-w-0"));
  assert.ok(wrapperClasses.has("justify-end"));
  const telnetPortInput = findInputByValue(markup, "2325");
  const inputClasses = classTokens(telnetPortInput);
  assert.ok(inputClasses.has("flex-1"));
  assert.ok(inputClasses.has("min-w-0"));
  assert.ok(inputClasses.has("text-center"));
  assert.equal(inputClasses.has("w-16"), false);
});

test("HostDetailsPanel displays inherited telnet port before falling back to 23", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData: {
            ...hostWithMissingProxyProfile,
            protocol: "telnet",
            telnetEnabled: true,
            telnetPort: undefined,
            port: undefined,
            group: "network",
            proxyProfileId: undefined,
          },
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: ["network"],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          groupConfigs: [{ path: "network", telnetPort: 2325 }],
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

  assert.match(findInputByValue(markup, "2325"), /type="number"/);
});

test("HostDetailsPanel uses group telnet port instead of ssh port for optional telnet", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData: {
            ...hostWithMissingProxyProfile,
            protocol: "ssh",
            telnetEnabled: true,
            telnetPort: undefined,
            port: 2222,
            group: "network",
            proxyProfileId: undefined,
          },
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: ["network"],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          groupConfigs: [{ path: "network", telnetPort: 2325 }],
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

  const telnetMarkup = markup.slice(markup.indexOf("Telnet on"));
  assert.match(findInputByValue(telnetMarkup, "2325"), /type="number"/);
  assert.doesNotMatch(telnetMarkup, /value="2222"/);
});

test("HostDetailsPanel displays inherited telnet credentials", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData: {
            ...hostWithMissingProxyProfile,
            protocol: "telnet",
            telnetEnabled: true,
            telnetUsername: undefined,
            telnetPassword: undefined,
            username: "ssh-user",
            password: "ssh-password",
            group: "network",
            proxyProfileId: undefined,
          },
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: ["network"],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          groupConfigs: [{
            path: "network",
            telnetUsername: "group-telnet-user",
            telnetPassword: "group-telnet-password",
          }],
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

  assert.match(markup, /placeholder="Telnet Username"[^>]*value="group-telnet-user"/);
  assert.match(markup, /placeholder="Telnet Password"[^>]*value="group-telnet-password"/);
  assert.doesNotMatch(markup, /placeholder="Telnet Username"[^>]*value="ssh-user"/);
  assert.doesNotMatch(markup, /placeholder="Telnet Password"[^>]*value="ssh-password"/);
});

test("parseOptionalPortInput clears empty port values", () => {
  assert.equal(parseOptionalPortInput(""), undefined);
  assert.equal(parseOptionalPortInput("2325"), 2325);
});

test("HostDetailsPanel does not offer to disable telnet when telnet is the primary protocol", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 23,
    proxyProfileId: undefined,
  });
  const telnetHeader = markup.match(/Telnet on[\s\S]*?Credentials/);

  assert.ok(telnetHeader);
  assert.doesNotMatch(telnetHeader[0], /hover:text-destructive/);
});
