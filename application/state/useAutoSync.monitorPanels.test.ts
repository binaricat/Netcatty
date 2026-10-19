import { installBrowserLockFixture } from "../testSupport/browserLockFixture";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MonitorPanel } from "../../domain/monitorPanels";
import type { CloudProvider, SyncResult, SyncPayload } from "../../domain/sync";

installBrowserLockFixture();

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};
const events = new EventTarget();
for (const key of [
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: events[key].bind(events),
  });
}
const windowFixture = Object.assign(events, {
  localStorage: storage,
  CustomEvent,
  setInterval,
  clearInterval,
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: windowFixture,
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: Object.assign(new EventTarget(), { visibilityState: "hidden" }),
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { useAutoSync } = await import("./useAutoSync");
const { getCloudSyncManager } =
  await import("../../infrastructure/services/CloudSyncManager");
const { saveMonitorPanel, deleteMonitorPanel, writeMonitorPanels } =
  await import("./monitorPanelsStorage");

test("normal manual and debounced auto-sync upload panel creation, edits and deletion", async () => {
  const manager = getCloudSyncManager();
  const snapshot = {
    ...manager.getState(),
    securityState: "UNLOCKED" as const,
    syncState: "IDLE" as const,
    autoSyncEnabled: true,
    providers: {
      ...manager.getState().providers,
      webdav: { provider: "webdav" as const, status: "connected" as const },
    },
  };
  const uploads: SyncPayload[] = [];
  const originals = {
    getState: manager.getState,
    syncAllProviders: manager.syncAllProviders,
    loadSyncBase: manager.loadSyncBase,
    inspectProviderRemote: manager.inspectProviderRemote,
    setPendingLocalSync: manager.setPendingLocalSync,
    setAvailablePluginSyncProviders: manager.setAvailablePluginSyncProviders,
  };
  manager.getState = () => snapshot;
  manager.loadSyncBase = async () => null;
  manager.inspectProviderRemote = async () => ({
    remoteFile: null,
    payload: null,
    remoteChanged: false,
  });
  manager.syncAllProviders = async (payload) => {
    uploads.push(structuredClone(payload));
    return new Map<CloudProvider, SyncResult>([
      ["webdav", { provider: "webdav", success: true, action: "upload" }],
    ]);
  };
  manager.setPendingLocalSync = () => {};
  manager.setAvailablePluginSyncProviders = () => {};
  const panel: MonitorPanel = {
    id: "p",
    name: "Fleet",
    description: "",
    hostIds: ["h1", "h2"],
    view: "charts",
    interval: 10,
    range: 15,
    sort: "manual",
  };
  let api: ReturnType<typeof useAutoSync> | undefined;
  let renderer: ReactTestRenderer | undefined;
  const apply = async () => {};
  const Probe = () => {
    api = useAutoSync({
      hosts: [],
      keys: [],
      snippets: [],
      customGroups: ["fixture"],
      startupReady: true,
      onApplyPayload: apply,
      onApplyConvergentPayload: apply,
    });
    return null;
  };
  const waitForUpload = async (count: number) => {
    // Flush the adapter's batched event, then observe the actual debounced
    // upload. Slow CI must not be mistaken for an incomplete collection.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (uploads.length === count) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3500));
      });
    } else {
      const deadline = Date.now() + 10000;
      while (uploads.length < count && Date.now() < deadline)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
    }
    assert.equal(
      uploads.length,
      count,
      "a panel-only change must alter the auto-sync hash and upload",
    );
  };
  try {
    writeMonitorPanels([
      { ...panel, stats: { cpu: 42 }, points: [1], running: true },
    ]);
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await act(async () => {
      assert.equal(await api!.syncNow({ trigger: "manual" }), true);
    });
    assert.deepEqual(uploads[0].monitorPanels, [panel]);
    const renamed = { ...panel, name: "Renamed" };
    await act(async () => {
      await saveMonitorPanel(panel, renamed);
    });
    await waitForUpload(2);
    assert.deepEqual(uploads[1].monitorPanels, [renamed]);
    const edited = {
      ...renamed,
      hostIds: ["h2"],
      view: "list" as const,
      interval: 30 as const,
    };
    await act(async () => {
      await saveMonitorPanel(renamed, edited);
    });
    await waitForUpload(3);
    assert.deepEqual(uploads[2].monitorPanels, [edited]);
    await act(async () => {
      await deleteMonitorPanel(panel.id);
    });
    await waitForUpload(4);
    assert.deepEqual(uploads[3].monitorPanels, []);
    await act(async () => {
      await saveMonitorPanel(null, panel);
    });
    await waitForUpload(5);
    assert.deepEqual(uploads[4].monitorPanels, [panel]);
    assert.ok(
      uploads.every((p) => !JSON.stringify(p.monitorPanels).includes("stats")),
    );
    await act(async () => {
      await saveMonitorPanel(panel, panel);
    });
    await waitForUpload(5);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    Object.assign(manager, originals);
  }
});

test("pending-sync indication coalesces edit bursts without repeatedly collecting the vault", async () => {
  const manager = getCloudSyncManager();
  const snapshot = {
    ...manager.getState(),
    securityState: "UNLOCKED" as const,
    syncState: "IDLE" as const,
    autoSyncEnabled: true,
    providers: {
      ...manager.getState().providers,
      webdav: { provider: "webdav" as const, status: "connected" as const },
    },
  };
  const originals = {
    getState: manager.getState,
    loadSyncBase: manager.loadSyncBase,
    inspectProviderRemote: manager.inspectProviderRemote,
    setPendingLocalSync: manager.setPendingLocalSync,
    setAvailablePluginSyncProviders: manager.setAvailablePluginSyncProviders,
  };
  manager.getState = () => snapshot;
  manager.loadSyncBase = async () => null;
  manager.inspectProviderRemote = async () => ({ remoteFile: null, payload: null, remoteChanged: false });
  const pending: boolean[] = [];
  manager.setPendingLocalSync = (value) => { pending.push(value); };
  manager.setAvailablePluginSyncProviders = () => {};
  let collects = 0;
  let collectBarrier: Promise<void> | undefined;
  Object.defineProperty(window, "netcatty", { configurable: true, value: {
    collectPluginSyncSidecars: async () => { collects++; await collectBarrier; return { version: 1, entries: [] }; },
  } });
  const apply = async () => {};
  const config = { hosts: [], keys: [], snippets: [], customGroups: ["fixture"], startupReady: true,
    onApplyPayload: apply, onApplyConvergentPayload: apply };
  function Probe({ enabled = true }: { enabled?: boolean }) { useAutoSync({ ...config, enabled }); return null; }
  let renderer: ReactTestRenderer | undefined;
  const wait = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  try {
    store.clear();
    writeMonitorPanels([{ id: "burst", name: "Before", description: "", hostIds: ["h"], view: "list", interval: 5, range: 15, sort: "manual" }]);
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await wait(500);
    const initial = collects;
    assert.ok(initial > 0, "startup still collects a real sync baseline");
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        writeMonitorPanels([{ id: "burst", name: `Edit ${i}`, description: "", hostIds: ["h"], view: "list", interval: 5, range: 15, sort: "manual" }]);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    assert.equal(collects, initial, "editing must not repeatedly collect all sync data");
    await wait(350);
    assert.equal(collects, initial + 1, "the final edit updates the pending indicator once");
    assert.equal(pending.at(-1), true);
    writeMonitorPanels([]);
    await wait(10);
    await act(async () => { renderer!.update(React.createElement(Probe, { enabled: false })); });
    const disabled = collects;
    await wait(350);
    assert.equal(collects, disabled, "disabling sync cancels the pending collection");
    assert.equal(pending.at(-1), false);
    await act(async () => { renderer!.update(React.createElement(Probe)); });
    await wait(350);
    let releaseCollection!: () => void;
    collectBarrier = new Promise<void>((resolve) => { releaseCollection = resolve; });
    const beforeInflight = collects;
    writeMonitorPanels([{ id: "burst", name: "New edit", description: "", hostIds: ["h"], view: "list", interval: 5, range: 15, sort: "manual" }]);
    await wait(10);
    await wait(350);
    assert.equal(collects, beforeInflight + 1, "the pending collection has started");
    await act(async () => { renderer!.update(React.createElement(Probe, { enabled: false })); });
    await act(async () => { releaseCollection(); });
    assert.equal(pending.at(-1), false, "an old collection cannot re-enable the indicator after disabling sync");
  } finally {
    await act(async () => renderer?.unmount());
    Reflect.deleteProperty(window, "netcatty");
    Object.assign(manager, originals);
  }
});
