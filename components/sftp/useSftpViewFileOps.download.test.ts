import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SftpFileEntry } from "../../types";
import type { SftpStateApi } from "../../application/state/useSftpState";
import { useSftpViewFileOps } from "./hooks/useSftpViewFileOps";

const file = (
  name: string, size: number, type: SftpFileEntry["type"] = "file",
  linkTarget?: SftpFileEntry["linkTarget"],
): SftpFileEntry => ({
  name, size, type, linkTarget, lastModified: 0, sizeFormatted: "", lastModifiedFormatted: "",
});

test("single and batch downloads route by current remote type and size", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  const current = new Map<string, SftpStatResult>([
    ["/remote/smaller", { name: "smaller", size: 50_000, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/larger", { name: "larger", size: 50_000, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/became-dir", { name: "became-dir", size: 0, sizeKnown: true, type: "directory", lastModified: 0 }],
    ["/remote/became-file", { name: "became-file", size: 12, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/changes-in-picker", { name: "changes-in-picker", size: 15, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/type-changes-in-picker", { name: "type-changes-in-picker", size: 15, sizeKnown: true, type: "file", lastModified: 0 }],
    ["/remote/statless", { name: "statless", size: 0, sizeKnown: false, type: "file", lastModified: 0 }],
    ["/remote/file-link", { name: "file-link", size: 9, sizeKnown: true, type: "symlink", lastModified: 0 }],
    ["/remote/dir-link", { name: "dir-link", size: 9, sizeKnown: true, type: "symlink", lastModified: 0 }],
  ]);
  const downloads: Array<{ sourcePath: string; totalBytes?: number; isDirectory: boolean }> = [];
  let saveCalls = 0;
  let directoryCalls = 0;
  let onSave: (name: string) => void = () => undefined;
  const connection = { id: "conn-1", hostId: "host-1", hostLabel: "Host", currentPath: "/remote", isLocal: false };
  const pane = { connection, filenameEncoding: "auto" };
  const sftpRef = { current: {
    leftPane: pane, rightPane: pane,
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    downloadToLocal: async (params: { sourcePath: string; totalBytes?: number; isDirectory: boolean }) => {
      downloads.push(params);
      return "completed";
    },
  } as unknown as SftpStateApi };
  let ops: ReturnType<typeof useSftpViewFileOps> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpViewFileOps({
      sftpRef,
      behaviorRef: { current: "" },
      autoSyncRef: { current: false },
      getOpenerForFileRef: { current: () => null },
      setOpenerForExtension: () => undefined,
      t: (key) => key,
      showSaveDialog: async (name) => { saveCalls++; onSave(name); return `/downloads/${name}`; },
      selectDirectory: async () => { directoryCalls++; return "/downloads"; },
      getSftpIdForConnection: () => "sftp-1",
      statSftp: async (_id, path) => current.get(path) ?? null as unknown as SftpStatResult,
      listSftp: async (_id, parent) => {
        assert.equal(parent, "/remote");
        return [
          { name: "file-link", type: "symlink", linkTarget: "file", size: "9 bytes", lastModified: "" },
          { name: "dir-link", type: "symlink", linkTarget: "directory", size: "9 bytes", lastModified: "" },
        ];
      },
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const single = ops!.onDownloadFileLeft as unknown as (entry: SftpFileEntry) => Promise<void>;
    const batch = ops!.onDownloadFilesLeft as unknown as (entries: SftpFileEntry[]) => Promise<void>;

    await act(async () => { await single(file("smaller", 100_000)); });
    await act(async () => { await single(file("larger", 25_000)); });
    assert.deepEqual(downloads.map(({ totalBytes }) => totalBytes), [50_000, 50_000]);
    assert.equal(saveCalls, 2, "save dialog still opens for every single-file download");

    onSave = (name) => {
      if (name === "changes-in-picker") current.set("/remote/changes-in-picker", {
        name, size: 30, sizeKnown: true, type: "file", lastModified: 0,
      });
      if (name === "type-changes-in-picker") current.set("/remote/type-changes-in-picker", {
        name, size: 0, sizeKnown: true, type: "directory", lastModified: 0,
      });
    };
    await act(async () => { await single(file("changes-in-picker", 100)); });
    assert.equal(downloads.at(-1)?.totalBytes, 30, "size is checked again after Save As");
    const countBeforeTypeChange = downloads.length;
    await act(async () => { await single(file("type-changes-in-picker", 100)); });
    assert.equal(downloads.length, countBeforeTypeChange, "type changes during Save As abort the transfer");
    const countBeforeMissing = saveCalls;
    await act(async () => { await single(file("missing", 100_000)); });
    assert.equal(saveCalls, countBeforeMissing, "missing source never opens Save As");

    await act(async () => { await single(file("statless", 100_000)); });
    assert.equal(downloads.at(-1)?.totalBytes, undefined, "stat-less SCP does not use listed size");
    await act(async () => { await single(file("file-link", 9, "symlink", "directory")); });
    assert.equal(downloads.at(-1)?.isDirectory, false);
    assert.equal(downloads.at(-1)?.totalBytes, undefined, "link node size is not file size");

    await act(async () => { await single(file("became-dir", 100_000)); });
    assert.equal(downloads.at(-1)?.isDirectory, true);
    assert.equal(directoryCalls, 1);

    await act(async () => {
      await batch([
        file("became-file", 0, "directory"),
        file("missing", 100_000),
        file("dir-link", 9, "symlink", "file"),
      ]);
    });
    assert.equal(directoryCalls, 2, "batch chooses one directory");
    const becameFile = downloads.find(({ sourcePath }) => sourcePath === "/remote/became-file");
    assert.equal(becameFile?.isDirectory, false);
    assert.equal(becameFile?.totalBytes, 12);
    assert.equal(downloads.find(({ sourcePath }) => sourcePath === "/remote/dir-link")?.isDirectory, true);
    assert.equal(downloads.some(({ sourcePath }) => sourcePath === "/remote/missing"), false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
