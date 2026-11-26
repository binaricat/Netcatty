import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import {
  clearAllKnownRemoteDesktopCerts,
  trustKnownRemoteDesktopCert,
} from "./remoteDesktop/knownRemoteDesktopCerts.ts";
import KnownHostsManager from "./KnownHostsManager.tsx";
import {
  RemoteDesktopCertList,
  filterAndSortRemoteDesktopCerts,
  isRemoteDesktopCertExpired,
  truncateFingerprint,
} from "./vault/RemoteDesktopCertList.tsx";

const renderWithI18n = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>{node}</TooltipProvider>
    </I18nProvider>,
  );

const installStorageStub = () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  return values;
};

test("KnownHostsManager renders SSH Host Keys and Remote Desktop Certificates tabs with counts", () => {
  installStorageStub();
  trustKnownRemoteDesktopCert(
    "rdp",
    "win-prod.local",
    3389,
    {
      fingerprintSha256: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      subject: "CN=win-prod.local",
      issuer: "CN=Corp CA",
      validTo: "2030-01-01T00:00:00Z",
    },
    1_700_000_000_000,
  );

  const markup = renderWithI18n(
    React.createElement(KnownHostsManager, {
      knownHosts: [
        {
          id: "kh-1",
          hostname: "bastion.example.com",
          port: 22,
          keyType: "ssh-ed25519",
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
          discoveredAt: 1_700_000_000_000,
        },
      ],
      hosts: [],
      onSave: () => {},
      onUpdate: () => {},
      onReorder: () => {},
      onDelete: () => {},
      onConvertToHost: () => {},
      onImportFromFile: () => {},
      onRefresh: () => {},
    }),
  );

  assert.match(markup, /role="tablist"/);
  assert.match(markup, /data-known-hosts-tab="ssh"/);
  assert.match(markup, /data-known-hosts-tab="certs"/);
  assert.match(markup, /bastion\.example\.com/);
});

test("RemoteDesktopCertList renders protocol badges, truncated SHA-256, and expired badge", () => {
  installStorageStub();
  clearAllKnownRemoteDesktopCerts();

  const certs = [
    {
      key: "rdp:win-prod.local:3389",
      protocol: "rdp" as const,
      host: "win-prod.local",
      port: 3389,
      fingerprintSha256: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      subject: "CN=win-prod.local",
      issuer: "CN=Corp CA",
      validFrom: "2020-01-01T00:00:00Z",
      validTo: "2021-01-01T00:00:00Z",
      trustedAt: 2000,
      lastSeenAt: 2500,
    },
    {
      key: "vnc:::1:5901",
      protocol: "vnc" as const,
      host: "::1",
      port: 5901,
      fingerprintSha256: "11:22:33:44:55:66",
      trustedAt: 1000,
      lastSeenAt: 1500,
    },
  ];

  const markup = renderWithI18n(
    React.createElement(RemoteDesktopCertList, {
      certs,
      search: "",
      viewMode: "grid",
      sortMode: "newest",
      onRequestRevoke: () => {},
    }),
  );

  assert.match(markup, /data-section="known-remote-desktop-certs"/);
  assert.match(markup, /win-prod\.local:3389/);
  assert.match(markup, /\[::1\]:5901/);
  assert.match(markup, />RDP</);
  assert.match(markup, />VNC</);
  assert.equal(isRemoteDesktopCertExpired("2021-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")), true);
  assert.equal(isRemoteDesktopCertExpired("2030-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")), false);

  const filtered = filterAndSortRemoteDesktopCerts(certs, "corp ca", "az");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].key, "rdp:win-prod.local:3389");

  const sortedAz = filterAndSortRemoteDesktopCerts(certs, "", "az");
  assert.equal(sortedAz[0].host, "::1");
  assert.equal(sortedAz[1].host, "win-prod.local");

  assert.equal(truncateFingerprint("AA:BB:CC", 20), "AA:BB:CC");
  assert.ok(truncateFingerprint("AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66", 20).includes("…"));
});
