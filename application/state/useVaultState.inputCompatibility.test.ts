import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { JSDOM } from "jsdom";
import { installBrowserLockFixture } from "../testSupport/browserLockFixture";
import type { Host } from "../../domain/models";
import { STORAGE_KEY_HOSTS } from "../../infrastructure/config/storageKeys";

// Exercise actual vault save/load/JSON import and sync boundaries, including
// the asynchronous encrypted-field adapter (without a native safeStorage key).
test("host input choices survive save, restart, duplicate, backup and cloud sync", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  const globals = ["window", "localStorage", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT", "navigator"];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    CustomEvent: { value: dom.window.CustomEvent, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  installBrowserLockFixture();
  const { useVaultState } = await import("./useVaultState");
  const { buildSyncPayload, applySyncPayload, buildLocalVaultPayload, applyLocalVaultPayload } = await import("../syncPayload");
  const { buildVaultHostFromDraft } = await import("../../domain/vaultHostCreate");
  const legacy: Host = { id: "legacy", label: "Legacy", hostname: "localhost", username: "agent", protocol: "ssh", tags: [], os: "linux" };
  dom.window.localStorage.setItem(STORAGE_KEY_HOSTS, JSON.stringify([legacy]));
  let state: ReturnType<typeof useVaultState>;
  let renderer: ReactTestRenderer | undefined;
  const Probe = () => { state = useVaultState({ syncConnectionLogTerminalData: false }); return null; };
  const mount = async () => {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    for (let attempt = 0; !state!.isInitialized && attempt < 50; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    assert.equal(state!.isInitialized, true);
    await act(async () => { await state!.readPersistedHosts(); });
  };
  const choices = () => state!.hosts.map(host => [host.id, host.sshInputCompatibility]);
  try {
    await mount();
    assert.deepEqual(choices(), [["legacy", true]]);
    const created = buildVaultHostFromDraft({ hostname: "new.example.test", username: "agent" });
    if (created.ok === false) throw Error(created.error);
    assert.equal(created.ok, true);
    const standard = { ...created.host, id: "standard" };
    await act(async () => { await state!.updateHosts([...state!.hosts, standard]); });
    assert.deepEqual(choices(), [["legacy", true], ["standard", false]]);
    const duplicate = { ...state!.hosts[0], id: "copy", label: "Legacy copy" };
    await act(async () => { await state!.updateHosts([...state!.hosts, duplicate]); });
    await act(async () => { renderer!.unmount(); });
    await mount();
    assert.deepEqual(choices(), [["legacy", true], ["standard", false], ["copy", true]]);
    // A later deliberate false must survive migration, including another boot.
    await act(async () => { await state!.updateHosts(state!.hosts.map(host => host.id === "legacy" ? { ...host, sshInputCompatibility: false } : host)); });
    const expected = [["legacy", false], ["standard", false], ["copy", true]];
    const exported = JSON.stringify(state!.exportData());
    await act(async () => { await state!.updateHosts([]); await state!.importDataFromString(exported); });
    assert.deepEqual(choices(), expected);
    // Use the real sync payload builder and apply importer, not JSON alone.
    const cloud = JSON.parse(JSON.stringify(buildSyncPayload({ ...state!.exportData(), identities: state!.identities, knownHosts: state!.knownHosts })));
    await act(async () => { await state!.updateHosts([]); await applySyncPayload(cloud, { importVaultData: state!.importDataFromString }); });
    assert.deepEqual(choices(), expected);
    const backup = JSON.parse(JSON.stringify(buildLocalVaultPayload({ ...state!.exportData(), identities: state!.identities, knownHosts: state!.knownHosts })));
    await act(async () => { await state!.updateHosts([]); await applyLocalVaultPayload(backup, { importVaultData: state!.importDataFromString }); });
    assert.deepEqual(choices(), expected);
    await act(async () => { renderer!.unmount(); });
    await mount();
    assert.deepEqual(choices(), expected);
    assert.deepEqual((await state!.readPersistedHosts()).map(host => [host.id, host.sshInputCompatibility]), expected);
    // Older cloud snapshots enter through the same per-record migration.
    cloud.hosts = [{ ...legacy, id: "cloud-legacy" }];
    await act(async () => { await applySyncPayload(cloud, { importVaultData: state!.importDataFromString }); });
    assert.deepEqual(choices(), [["cloud-legacy", true]]);
    await act(async () => { await state!.updateHosts(state!.hosts.map(host => ({ ...host, sshInputCompatibility: false }))); });
    await act(async () => { renderer!.unmount(); });
    await mount();
    assert.deepEqual(choices(), [["cloud-legacy", false]]);
    // These drafts enter HostDetailsPanel as initialData, then the real vault
    // save/normalization path. They must not be mistaken for legacy records.
    const { buildSshDeepLinkHostDraft, parseSshDeepLink } = await import("../../domain/sshDeepLink");
    const { normalizePluginImporterRecords } = await import("../../domain/pluginImporter");
    const linkDraft = buildSshDeepLinkHostDraft(parseSshDeepLink("ssh://agent@new.test")!, { id: "new-link", now: 1 });
    const imported = normalizePluginImporterRecords([undefined, false, true].map(choice => ({
      type: "draft" as const, draft: { kind: "host" as const, value: {
        hostname: `import-${choice}.test`, protocol: "ssh",
        ...(choice === undefined ? {} : { sshInputCompatibility: choice }),
      } },
    })));
    assert.deepEqual(imported.errors, []);
    const explicitCopy = { ...imported.hosts[2], id: "copy-explicit-input" };
    const drafts = [linkDraft, ...imported.hosts, explicitCopy];
    const draftChoices = drafts.map(host => [host.id, host.sshInputCompatibility]);
    assert.deepEqual(drafts.map(host => host.sshInputCompatibility), [false, false, false, true, true]);
    await act(async () => { await state!.updateHosts([...state!.hosts, ...drafts]); });
    await act(async () => { renderer!.unmount(); });
    await mount();
    assert.deepEqual(choices(), [["cloud-legacy", false], ...draftChoices]);
  } finally {
    await act(async () => { renderer?.unmount(); });
    dom.window.close();
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
