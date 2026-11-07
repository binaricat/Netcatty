import assert from "node:assert/strict";
import test from "node:test";
import type { SftpPane } from "./types";
import type { SftpArchiveCreationResult } from "../../../domain/sftpArchiveCreation";
import { createSftpArchiveForPane } from "./createSftpArchive.ts";

function setup() {
  let pane = {
    id: "pane-a", connection: { id: "connection-a", isLocal: false }, filenameEncoding: "gb18030",
  } as SftpPane;
  const calls: unknown[][] = [];
  const refreshes: string[] = [];
  const params = {
    getPane: () => pane,
    target: { paneId: "pane-a", connectionId: "connection-a" },
    options: { directory: "/srv", paths: ["中文", "logs"], archiveName: "backup.zip", format: "zip" as const },
    getSftpIdForConnection: (id: string) => id === "connection-a" ? "sftp-a" : undefined,
    bridge: {
      createSftpArchive: async (...args: unknown[]): Promise<SftpArchiveCreationResult> => {
        calls.push(args);
        return { success: true };
      },
    },
    refresh: async (id: string) => { refreshes.push(id); },
    t: (key: string) => key,
  };
  return { params, calls, refreshes, setPane: (value: SftpPane) => { pane = value; } };
}

test("archive creation passes selected paths and encoding to the captured remote session", async () => {
  const { params, calls, refreshes } = setup();
  assert.deepEqual(await createSftpArchiveForPane(params), { success: true });
  assert.deepEqual(calls, [["sftp-a", params.options, "gb18030"]]);
  assert.deepEqual(refreshes, ["pane-a"]);
});

test("a switched or disconnected pane cannot compress files on another host", async () => {
  for (const change of [
    { id: "pane-b" },
    { connection: { id: "connection-b", isLocal: false } },
    { connection: null },
  ]) {
    const { params, calls, setPane } = setup();
    setPane({ ...params.getPane(), ...change } as SftpPane);
    await assert.rejects(createSftpArchiveForPane(params), /connectionChanged/);
    assert.equal(calls.length, 0);
  }
});

test("archive creation requires a remote session and a supported bridge", async () => {
  const { params, calls, setPane } = setup();
  await assert.rejects(createSftpArchiveForPane({ ...params, bridge: undefined }), /unavailable/);
  await assert.rejects(createSftpArchiveForPane({ ...params, getSftpIdForConnection: () => undefined }), /unavailable/);
  setPane({ ...params.getPane(), connection: { id: "connection-a", isLocal: true } } as SftpPane);
  await assert.rejects(createSftpArchiveForPane(params), /unavailable/);
  assert.equal(calls.length, 0);
});

test("existing archives are returned for confirmation without retry or refresh", async () => {
  const { params, refreshes } = setup();
  const conflict = { success: false, code: "EEXIST", error: "Already exists" };
  params.bridge.createSftpArchive = async () => conflict;
  assert.equal(await createSftpArchiveForPane(params), conflict);
  assert.deepEqual(refreshes, []);
});

test("finishing after a tab switch does not refresh the new connection", async () => {
  const { params, refreshes, setPane } = setup();
  params.bridge.createSftpArchive = async () => {
    setPane({ ...params.getPane(), id: "pane-b" } as SftpPane);
    return { success: true };
  };
  assert.deepEqual(await createSftpArchiveForPane(params), { success: true });
  assert.deepEqual(refreshes, []);
});

test("a failed operation is not refreshed or converted to success", async () => {
  const { params, refreshes } = setup();
  params.bridge.createSftpArchive = async () => { throw new Error("zip is not installed"); };
  await assert.rejects(createSftpArchiveForPane(params), /zip is not installed/);
  assert.deepEqual(refreshes, []);
});

test("a listing error after publication does not invite a second archive creation", async () => {
  const { params, calls } = setup();
  params.refresh = async () => { throw new Error("Disconnected after publication"); };
  assert.deepEqual(await createSftpArchiveForPane(params), { success: true });
  assert.equal(calls.length, 1);
});
