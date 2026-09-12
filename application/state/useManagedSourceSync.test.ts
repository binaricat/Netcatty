import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Host } from "../../domain/models.ts";
import { STORAGE_KEY_MANAGED_SOURCES } from "../../infrastructure/config/storageKeys.ts";
import { isVaultImportLockHeld } from "./vaultManagedImportLock.ts";
import { haveSameManagedSshAgentFields, useManagedSourceSync } from "./useManagedSourceSync.ts";

const host: Host = {
  id: "host-1",
  label: "Managed host",
  hostname: "managed.example.com",
  username: "root",
  port: 22,
  protocol: "ssh",
  os: "linux",
  tags: [],
};

test("managed SSH source comparison tracks every agent setting", () => {
  const changedFields: Array<keyof Host> = [
    "useSshAgent",
    "identityAgent",
    "identitiesOnly",
    "addKeysToAgent",
    "useKeychain",
  ];

  for (const field of changedFields) {
    const changed = {
      ...host,
      [field]: field === "identityAgent" || field === "addKeysToAgent"
        ? "changed"
        : true,
    };
    assert.equal(haveSameManagedSshAgentFields(host, changed), false, field);
  }

  assert.equal(haveSameManagedSshAgentFields(host, { ...host }), true);
});

test("managed SSH source comparison tracks identity file paths", () => {
  const withPaths = {
    ...host,
    identityFilePaths: ["~/.ssh/id_ed25519", "~/.ssh/id_backup"],
  };

  assert.equal(haveSameManagedSshAgentFields(host, withPaths), false);
  assert.equal(haveSameManagedSshAgentFields(withPaths, host), false);
  assert.equal(haveSameManagedSshAgentFields(withPaths, {
    ...withPaths,
    identityFilePaths: [...withPaths.identityFilePaths],
  }), true);
  assert.equal(haveSameManagedSshAgentFields(withPaths, {
    ...withPaths,
    identityFilePaths: [...withPaths.identityFilePaths].reverse(),
  }), false);
});

type TestHost = Host & { managedSourceId?: string };

const managedHost = (label: string): TestHost => ({
  ...host,
  label,
  managedSourceId: "source-1",
});

const managedSource = {
  id: "source-1",
  type: "ssh_config" as const,
  filePath: "/home/tester/.ssh/config",
  groupName: "Managed",
  lastSyncedAt: 0,
};

function createFakeLockManager() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const previous = (tails.get(name) ?? Promise.resolve()) as Promise<unknown>;
      const run = previous.then(callback, callback) as Promise<T>;
      tails.set(name, run.then(() => undefined, () => undefined));
      return run;
    },
  };
}

test("managed sync writes the latest persisted hosts, not the pre-edit snapshot", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  const globalAny = globalThis as Record<string, unknown>;
  const saved = {
    window: globalAny.window,
    document: globalAny.document,
    localStorage: globalAny.localStorage,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    actEnv: (globalAny as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: createFakeLockManager() },
  });
  Object.defineProperty(globalAny, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  try {
    dom.window.localStorage.setItem(
      STORAGE_KEY_MANAGED_SOURCES,
      JSON.stringify([managedSource]),
    );

    // Simulate updateHosts: the React state already holds the edited alias,
    // but the encrypted disk write is still queued and only lands later.
    const hostBeforeEdit = managedHost("aaaaaaaa");
    const hostAfterEdit = managedHost("bbbbbbbb");
    let persistedHosts: TestHost[] = [hostBeforeEdit];
    let resolveCommit!: () => void;
    const commit = new Promise<void>((resolve) => { resolveCommit = resolve; });
    setTimeout(() => {
      persistedHosts = [hostAfterEdit];
      resolveCommit();
    }, 20);

    const onReadPersistedHosts = async (): Promise<Host[]> => {
      // Mirrors the real readPersistedHosts semantics: while the vault lock is
      // held, only the encrypt phase is drained (the disk write queued behind
      // that lock is not visible yet); outside the lock it also waits for the
      // queued disk write before reading.
      if (isVaultImportLockHeld("vault")) return persistedHosts;
      await commit;
      return persistedHosts;
    };

    let written = "";
    (dom.window as unknown as Record<string, unknown>).netcatty = {
      readLocalFile: async () => new TextEncoder().encode(
        "# BEGIN NETCATTY MANAGED - DO NOT EDIT THIS BLOCK\n"
        + "Host aaaaaaaa\n    HostName managed.example.com\n"
        + "# END NETCATTY MANAGED\n",
      ).buffer,
      writeLocalFile: async (_filePath: string, buffer: ArrayBuffer) => {
        written = new TextDecoder().decode(buffer);
      },
    };

    function Harness() {
      useManagedSourceSync({
        hosts: [hostAfterEdit],
        managedSources: [managedSource],
        onUpdateManagedSources: () => {},
        onReadPersistedHosts,
      });
      return null;
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    for (let i = 0; i < 250 && !written; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await act(async () => root.unmount());
    assert.ok(written, "managed sync never wrote the ssh_config file");
    assert.ok(written.includes("Host bbbbbbbb"), "sync wrote a stale alias");
    assert.ok(!written.includes("Host aaaaaaaa"), "sync wrote the pre-edit alias");
  } finally {
    container.remove();
    dom.window.close();
    for (const key of ["window", "document", "localStorage"] as const) {
      if (key in globalAny) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: saved[key],
        });
      } else {
        delete globalAny[key];
      }
    }
    if (saved.navigator) {
      Object.defineProperty(globalThis, "navigator", saved.navigator);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
    Object.defineProperty(globalAny, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: saved.actEnv,
    });
  }
});
