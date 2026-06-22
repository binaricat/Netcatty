import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SSHKey } from "../types.ts";
import { HostDetailsConnectionSections } from "./HostDetailsConnectionSections.tsx";
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

const renderConnectionSections = (formOverrides: Record<string, unknown> = {}) =>
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
        update: () => {},
        groupDefaults: undefined,
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
