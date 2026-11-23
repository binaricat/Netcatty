import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SftpArchiveCreationResult } from "../../../domain/sftpArchiveCreation";
import { useSftpArchiveDialog } from "./useSftpArchiveDialog";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
environment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { environment.IS_REACT_ACT_ENVIRONMENT = previous; });

type Params = Parameters<typeof useSftpArchiveDialog>[0];

async function mount(overrides: Partial<Params> = {}) {
  let params: Params = {
    paneId: "pane-1", connectionId: "conn-1", isLocal: false, isActive: true,
    t: (key) => key, onCreateArchive: async () => ({ success: true }), onCreated: () => {},
    ...overrides,
  };
  let current!: ReturnType<typeof useSftpArchiveDialog>;
  function Probe() {
    current = useSftpArchiveDialog(params);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  return {
    get value() { return current; },
    async update(changes: Partial<Params>) {
      params = { ...params, ...changes };
      await act(async () => { renderer.update(React.createElement(Probe)); });
    },
    async unmount() { await act(async () => { renderer.unmount(); }); },
  };
}

test("archive dialog snapshots nested selections, format, and connection identity", async (t) => {
  const requests: unknown[] = [];
  const reloaded: string[] = [];
  const harness = await mount({
    onCreateArchive: async (options, target) => { requests.push({ options, target }); return { success: true }; },
    onCreated: (directory) => { reloaded.push(directory); },
  });
  t.after(() => harness.unmount());
  await act(async () => { harness.value.open(["/srv/site/assets", "/srv/site/assets/logo.png", "/srv/site/config/app.json"]); });
  assert.deepEqual(harness.value.state?.paths, ["assets", "config/app.json"]);
  assert.equal(harness.value.state?.directory, "/srv/site");
  await act(async () => { harness.value.setArchiveName("backup.tar.gz"); harness.value.setFormat("zip"); });
  assert.equal(harness.value.state?.archiveName, "backup.zip");
  await act(async () => { await harness.value.submit(); });
  assert.deepEqual(requests, [{
    options: { directory: "/srv/site", paths: ["assets", "config/app.json"], archiveName: "backup.zip", format: "zip", overwrite: false },
    target: { paneId: "pane-1", connectionId: "conn-1" },
  }]);
  assert.deepEqual(reloaded, ["/srv/site"]);
  assert.equal(harness.value.state, null);
});

test("archive dialog requires a separate overwrite decision and revokes it on edits", async (t) => {
  const overwriteFlags: Array<boolean | undefined> = [];
  const harness = await mount({ onCreateArchive: async (options) => {
    overwriteFlags.push(options.overwrite);
    return options.overwrite ? { success: true } : { success: false, code: "EEXIST" };
  } });
  t.after(() => harness.unmount());
  await act(async () => { harness.value.open(["/srv/site"]); });
  await act(async () => { await harness.value.submit(true); });
  assert.deepEqual(overwriteFlags, [], "overwrite is unavailable before a collision");
  await act(async () => { await harness.value.submit(); });
  assert.equal(harness.value.state?.confirmOverwrite, true);
  await act(async () => { await harness.value.submit(); });
  assert.deepEqual(overwriteFlags, [false], "Enter must not confirm overwrite");
  await act(async () => { harness.value.setArchiveName("other.tar.gz"); });
  assert.equal(harness.value.state?.confirmOverwrite, false);
  await act(async () => { await harness.value.submit(true); });
  assert.deepEqual(overwriteFlags, [false]);
  await act(async () => { await harness.value.submit(); });
  await act(async () => { await harness.value.submit(true); });
  assert.deepEqual(overwriteFlags, [false, false, true]);
  assert.equal(harness.value.state, null);
});

test("pending archive creation blocks duplicate submits, edits, and dismissal", async (t) => {
  let finish!: (result: SftpArchiveCreationResult) => void;
  let requests = 0;
  const harness = await mount({ onCreateArchive: async () => {
    requests += 1;
    return new Promise<SftpArchiveCreationResult>((resolve) => { finish = resolve; });
  } });
  t.after(() => harness.unmount());
  await act(async () => { harness.value.open(["/srv/site"]); });
  let pending!: Promise<void>;
  await act(async () => {
    pending = harness.value.submit();
    void harness.value.submit();
    harness.value.close();
    harness.value.setArchiveName("changed.tar.gz");
    harness.value.open(["/different"]);
  });
  assert.equal(requests, 1);
  assert.equal(harness.value.state?.busy, true);
  assert.equal(harness.value.state?.archiveName, "site.tar.gz");
  await act(async () => { finish({ success: true }); await pending; });
  assert.equal(harness.value.state, null);
});

test("switching connections dismisses the old dialog and ignores its late result", async (t) => {
  let finish!: (result: SftpArchiveCreationResult) => void;
  const reloaded: string[] = [];
  let requests = 0;
  const harness = await mount({
    onCreateArchive: async () => {
      requests += 1;
      return new Promise<SftpArchiveCreationResult>((resolve) => { finish = resolve; });
    },
    onCreated: (directory) => { reloaded.push(directory); },
  });
  t.after(() => harness.unmount());
  await act(async () => { harness.value.open(["/srv/site"]); });
  let pending!: Promise<void>;
  await act(async () => { pending = harness.value.submit(); });
  await harness.update({ connectionId: "conn-2" });
  assert.equal(harness.value.state, null);
  await act(async () => { harness.value.open(["/srv/new-site"]); });
  await act(async () => { finish({ success: false, code: "EEXIST" }); await pending; });
  assert.equal(requests, 1);
  assert.equal(harness.value.state?.archiveName, "new-site.tar.gz");
  assert.equal(harness.value.state?.confirmOverwrite, false);
  assert.deepEqual(reloaded, []);
});

test("tab switches invalidate the old form even when its connection stays mounted", async (t) => {
  let requests = 0;
  const harness = await mount({ onCreateArchive: async () => { requests += 1; return { success: true }; } });
  t.after(() => harness.unmount());
  await act(async () => { harness.value.open(["/srv/site"]); });
  const staleSubmit = harness.value.submit;
  await harness.update({ isActive: false });
  await act(async () => { await staleSubmit(); });
  assert.equal(harness.value.state, null);
  assert.equal(requests, 0);
  await harness.update({ isActive: true, isLocal: true });
  await act(async () => { harness.value.open(["/srv/site"]); });
  assert.equal(harness.value.state, null);
});

test("invalid names do not invoke the backend; failures keep a retryable form", async (t) => {
  let requests = 0;
  const harness = await mount({ onCreateArchive: async () => { requests += 1; throw new Error("zip is not installed"); } });
  t.after(() => harness.unmount());
  await act(async () => { harness.value.open(["/srv/site"]); harness.value.setArchiveName("../backup.tar.gz"); });
  await act(async () => { await harness.value.submit(); });
  assert.equal(requests, 0);
  assert.equal(harness.value.state?.error, "sftp.archive.invalidName");
  await act(async () => { harness.value.setArchiveName("backup.tar.gz"); });
  await act(async () => { await harness.value.submit(); });
  assert.equal(requests, 1);
  assert.equal(harness.value.state?.busy, false);
  assert.equal(harness.value.state?.error, "zip is not installed");
});
