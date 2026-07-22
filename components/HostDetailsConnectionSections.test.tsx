import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Host, SSHKey } from "../types.ts";
import {
  applyEffectiveHostAuthMethodSelection,
  detachEffectiveHostIdentity,
  HOST_AUTH_METHOD_CHOICES,
  HostDetailsConnectionSections,
  removeSelectedHostCredential,
  shouldForceAuthMethodReselect,
} from "./HostDetailsConnectionSections.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const longCredentialLabel =
  "D:\\download\\acdrOgxses_wuzh02.hpccube.com_really_really_long_private_key_name.pem";

const availableKey: SSHKey = {
  id: "key-1",
  label: longCredentialLabel,
  type: "ED25519",
  privateKey: "",
  publicKey: "",
  source: "imported",
  category: "key",
  created: 1,
};

const renderConnectionSections = (
  formOverrides: Record<string, unknown> = {},
  groupDefaults?: Record<string, unknown>,
) =>
  renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(HostDetailsConnectionSections, {
        t: (key: string) => key,
        form: {
          id: "host-1",
          label: "Host",
          hostname: "example.com",
          username: "root",
          port: 22,
          protocol: "ssh",
          os: "linux",
          authMethod: "key",
          identityFileId: availableKey.id,
          ...formOverrides,
        },
        setForm: () => {},
        update: () => {},
        groupDefaults,
        effectiveAuthMethod: formOverrides.effectiveAuthMethod || formOverrides.authMethod || "key",
        effectiveIdentityId: formOverrides.effectiveIdentityId || formOverrides.identityId,
        selectedIdentity: undefined,
        clearIdentity: () => {},
        identities: [],
        identitySuggestionsOpen: false,
        filteredIdentitySuggestions: [],
        setIdentitySuggestionsOpen: () => {},
        availableKeys: [availableKey],
        applyIdentity: () => {},
        showPassword: false,
        setShowPassword: () => {},
        pendingReferenceKeyPath: null,
        setPendingReferenceKeyPath: () => {},
        selectedCredentialType: null,
        setSelectedCredentialType: () => {},
        credentialPopoverOpen: false,
        setCredentialPopoverOpen: () => {},
        keysByCategory: { key: [availableKey], certificate: [] },
        newKeyFilePath: "",
        setNewKeyFilePath: () => {},
        addLocalKeyFilePath: () => {},
        handleDistroModeChange: () => {},
        distroOptions: [],
        effectiveFormDistro: undefined,
        getDistroOptionLabel: () => "",
      }),
    ),
  );

test("selected host credential keeps the remove button visible with a long name", () => {
  const markup = renderConnectionSections();

  assert.match(markup, new RegExp(longCredentialLabel.replaceAll("\\", "\\\\")));
  assert.match(
    markup,
    /class="flex items-center gap-2 min-w-0 overflow-hidden p-2 rounded-md bg-secondary\/50 border border-border\/60"/,
  );
  assert.match(markup, /class="text-sm min-w-0 flex-1 truncate"/);
  assert.match(markup, /class="[^"]*h-6 w-6 shrink-0[^"]*"/);
});

test("color and icon settings render for non-Linux hosts", () => {
  const markup = renderConnectionSections({
    os: "macos",
    distro: "macos",
    iconMode: "custom",
    iconId: "terminal",
  });

  assert.match(markup, /hostDetails\.icon\.sectionTitle/);
  assert.match(markup, /hostDetails\.icon\.colorLabel/);
  assert.match(markup, /hostDetails\.icon\.manualLabel/);
});

test("host credentials expose automatic and password-only choices", () => {
  const markup = renderConnectionSections({
    authMethod: "auto",
    identityFileId: undefined,
  });

  assert.deepEqual(
    HOST_AUTH_METHOD_CHOICES.map(([value, labelKey]) => [value, labelKey]),
    [
      ["auto", "hostDetails.auth.auto"],
      ["password", "hostDetails.auth.passwordOnly"],
      ["key", "hostDetails.auth.key"],
      ["certificate", "hostDetails.auth.certificate"],
    ],
  );
  assert.match(markup, /hostDetails\.auth\.method/);
  assert.match(markup, /role="combobox"[^>]*aria-label="hostDetails\.auth\.method"/);
  assert.match(markup, /hostDetails\.auth\.auto/);
  assert.match(markup, /hostDetails\.auth\.mfaFirst/);
  // Login method uses the same option-style setting row as other host form controls.
  assert.match(
    markup,
    /hostDetails\.auth\.method[\s\S]*?role="combobox"[\s\S]*?hostDetails\.auth\.auto[\s\S]*?<\/div>\s*<div class="flex h-12 items-center justify-between gap-3 rounded-lg border border-border\/60 bg-secondary\/40 px-3">[\s\S]*hostDetails\.auth\.mfaFirst/,
  );
  assert.match(markup, /class="[^"]*h-8 w-32[^"]*"/);
  assert.match(
    markup,
    /role="combobox"[\s\S]*?<span class="min-w-0 flex-1 truncate text-left">hostDetails\.auth\.auto<\/span>/,
  );
});

test("wires same-value key/certificate reselect through pointer and keyboard handlers", () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "HostDetailsConnectionSections.tsx"),
    "utf8",
  );
  assert.match(source, /onPointerUp=\{\(\) => \{[\s\S]*shouldForceAuthMethodReselect/);
  assert.match(source, /onKeyDown=\{\(event\) => \{[\s\S]*shouldForceAuthMethodReselect/);
  assert.doesNotMatch(source, /onSelect=\{\(\) => \{[\s\S]*shouldForceAuthMethodReselect/);
});

test("reselecting the current key or certificate method still forces the chooser path", () => {
  assert.equal(shouldForceAuthMethodReselect("key", "key"), true);
  assert.equal(shouldForceAuthMethodReselect("certificate", "certificate"), true);
  assert.equal(shouldForceAuthMethodReselect("password", "password"), false);
  assert.equal(shouldForceAuthMethodReselect("auto", "auto"), false);
  assert.equal(shouldForceAuthMethodReselect("key", "password"), false);
});

test("ET hosts do not offer the unsupported interactive-auth preference", () => {
  const legacyEtMarkup = renderConnectionSections({ etEnabled: true });
  const explicitEtMarkup = renderConnectionSections({ protocol: "et" });
  const inheritedEtMarkup = renderConnectionSections({}, { etEnabled: true });
  const hostOverrideMarkup = renderConnectionSections(
    { etEnabled: false },
    { etEnabled: true },
  );

  assert.doesNotMatch(legacyEtMarkup, /hostDetails\.auth\.mfaFirst/);
  assert.doesNotMatch(explicitEtMarkup, /hostDetails\.auth\.mfaFirst/);
  assert.doesNotMatch(inheritedEtMarkup, /hostDetails\.auth\.mfaFirst/);
  assert.match(hostOverrideMarkup, /hostDetails\.auth\.mfaFirst/);
});

test("host authentication choices remain visible for a selected identity", () => {
  const markup = renderConnectionSections({
    identityId: "identity-1",
    authMethod: "password",
  });

  assert.match(markup, /hostDetails\.auth\.method/);
  assert.match(markup, /role="combobox"[^>]*aria-label="hostDetails\.auth\.method"/);
  assert.match(
    markup,
    /role="combobox"[\s\S]*?<span class="min-w-0 flex-1 truncate text-left">hostDetails\.auth\.passwordOnly<\/span>/,
  );
});

test("host authentication choices show the inherited effective method", () => {
  const markup = renderConnectionSections({
    authMethod: undefined,
    identityFileId: undefined,
    effectiveAuthMethod: "password",
  });

  assert.match(markup, /hostDetails\.auth\.method/);
  assert.match(markup, /role="combobox"[^>]*aria-label="hostDetails\.auth\.method"/);
  assert.match(
    markup,
    /role="combobox"[\s\S]*?<span class="min-w-0 flex-1 truncate text-left">hostDetails\.auth\.passwordOnly<\/span>/,
  );
});

test("reselecting an inherited authentication method preserves group credentials", () => {
  const host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "root",
  } as Host;

  assert.equal(applyEffectiveHostAuthMethodSelection(host, "key", "key"), host);
});

test("selecting automatic opts out of an inherited identity", () => {
  const host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "root",
    authMethod: "auto",
  } as Host;

  assert.deepEqual(
    applyEffectiveHostAuthMethodSelection(host, "auto", "password"),
    {
      ...host,
      authPolicyVersion: 1,
      identityId: "",
      identityFileId: undefined,
      identityFilePaths: undefined,
      identityAgent: undefined,
      identitiesOnly: undefined,
      useSshAgent: undefined,
    },
  );
});

test("overriding inherited authentication preserves the effective username", () => {
  const host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "",
  } as Host;

  assert.equal(
    applyEffectiveHostAuthMethodSelection(host, "password", "key", "deploy").username,
    "deploy",
  );
});

test("detaching an inherited identity preserves the effective username", () => {
  const host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "",
  } as Host;

  assert.deepEqual(detachEffectiveHostIdentity(host, "deploy"), {
    ...host,
    identityId: "",
    username: "deploy",
  });
});

test("removing a selected key resets stale agent settings for automatic auth", () => {
  const host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "root",
    authMethod: "key",
    authPolicyVersion: 1,
    identityFileId: "key-1",
    useSshAgent: false,
  } as Host;

  assert.deepEqual(removeSelectedHostCredential(host, "key"), {
    ...host,
    authMethod: "auto",
    identityId: "",
    identityFileId: undefined,
    identityFilePaths: undefined,
    identityAgent: undefined,
    identitiesOnly: undefined,
    useSshAgent: undefined,
  });
});

test("an inherited deleted identity remains visible and clearable", () => {
  const markup = renderConnectionSections({
    authMethod: undefined,
    identityFileId: undefined,
    effectiveAuthMethod: "auto",
    effectiveIdentityId: "deleted-group-identity",
  });

  assert.match(markup, /hostDetails\.identity\.missing/);
  assert.doesNotMatch(markup, /placeholder="hostDetails\.username\.placeholder"/);
});
