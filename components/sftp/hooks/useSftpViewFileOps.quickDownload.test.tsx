import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SftpFileEntry } from "../../../types";
import type { LocalDownloadTargetExpectation } from "../../../domain/models";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { STORAGE_KEY_SFTP_QUICK_DOWNLOAD } from "../../../infrastructure/config/storageKeys";
import { useSftpViewFileOps } from "./useSftpViewFileOps";

const file = (name: string, type: SftpFileEntry["type"] = "file"): SftpFileEntry => ({
  name, type, size: 3, lastModified: 0, sizeFormatted: "", lastModifiedFormatted: "",
});

test("quick download reuses only the exact target selected for the same remote file", async () => {
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  const storage = new Map<string, string>([[STORAGE_KEY_SFTP_QUICK_DOWNLOAD, "true"]]);
  const deviceId = "9007199254740993";
  const existingFiles = new Map<string, "file" | "directory" | "symlink">();
  const fileInodes = new Map<string, number>();
  const fileBirthtimes = new Map<string, string>();
  const fileCtimes = new Map<string, string>();
  const fileMtimes = new Map<string, string>();
  let nextFileInode = 1000;
  let replaceAfterPublication = false;
  let modifyAfterPublication = false;
  const existingDirectories = new Set(["/downloads", "/batch"]);
  const realParents = new Map([["/downloads", "/downloads"], ["/batch", "/batch"]]);
  const parentInodes = new Map([["/downloads", 100], ["/batch", 200]]);
  const remoteTypes = new Map<string, "file" | "directory">([["/remote/folder", "directory"]]);
  const downloads: Array<{
    sourcePath: string; targetPath: string; isDirectory: boolean;
    expectedLocalTarget?: LocalDownloadTargetExpectation;
  }> = [];
  const savePaths = [
    "/downloads/renamed.txt",
    "/downloads/other.txt",
    "/downloads/reselected.txt",
    "/downloads/type-reselected.txt",
    "/downloads/moved-reselected.txt",
    "/downloads/parent-restored.txt",
    "/downloads/mount-reselected.txt",
    "/downloads/other-endpoint.txt",
    "/downloads/disabled.txt",
    "/downloads/re-enabled.txt",
    "/downloads/replaced-reselected.txt",
    "/downloads/reused-inode-reselected.txt",
    "/downloads/post-publication-reselected.txt",
    "/downloads/in-place-reselected.txt",
  ];
  let saveCalls = 0;
  let directoryCalls = 0;
  let endpointKey = "host-1:server-a:22:ssh::user:sftp";
  const connection = { id: "conn-1", hostId: "host-1", hostLabel: "Host", currentPath: "/remote", isLocal: false };
  const pane = { connection, filenameEncoding: "auto" };
  const sftpRef = { current: {
    leftPane: pane, rightPane: pane,
    getDownloadEndpointKey: async () => endpointKey,
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    downloadToLocal: async (params: {
      sourcePath: string; targetPath: string; isDirectory: boolean;
      expectedLocalTarget?: LocalDownloadTargetExpectation;
      onPublishedLocalFile?: (identity: { dev: string; ino: string; birthtimeNs: string; ctimeNs: string; mtimeNs: string; sha256: string }) => void;
    }) => {
      downloads.push(params);
      existingFiles.set(params.targetPath, params.isDirectory ? "directory" : "file");
      if (!params.isDirectory) {
        const inode = nextFileInode++;
        fileInodes.set(params.targetPath, inode);
        fileBirthtimes.set(params.targetPath, String(inode * 1000));
        fileCtimes.set(params.targetPath, String(inode * 1000));
        fileMtimes.set(params.targetPath, String(inode * 1000));
        params.onPublishedLocalFile?.({ dev: deviceId, ino: String(inode), birthtimeNs: String(inode * 1000),
          ctimeNs: String(inode * 1000), mtimeNs: String(inode * 1000), sha256: "a".repeat(64) });
        if (modifyAfterPublication) {
          modifyAfterPublication = false;
          fileCtimes.set(params.targetPath, String(inode * 1000 + 1));
          fileMtimes.set(params.targetPath, String(inode * 1000 + 1));
        }
        if (replaceAfterPublication) {
          replaceAfterPublication = false;
          fileInodes.set(params.targetPath, 555);
          fileBirthtimes.set(params.targetPath, "555000");
        }
      }
      return "completed";
    },
  } as unknown as SftpStateApi };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  (globalThis as { window?: unknown }).window = { netcatty: {
    statLocal: async (path: string) => {
      if (!existingDirectories.has(path)) throw new Error("ENOENT");
      return { type: "directory", dev: deviceId, ino: String(parentInodes.get(path)), birthtimeNs: String(parentInodes.get(path)! * 1000) };
    },
    lstatLocal: async (path: string) => {
      const type = existingFiles.get(path);
      if (!type) throw new Error("ENOENT");
      return { type, dev: deviceId, ino: String(fileInodes.get(path)),
        birthtimeNs: fileBirthtimes.get(path), ctimeNs: fileCtimes.get(path), mtimeNs: fileMtimes.get(path) };
    },
    realpathLocal: async (path: string) => {
      const real = realParents.get(path);
      if (!real) throw new Error("ENOENT");
      return real;
    },
    statSftp: async (_id: string, path: string) => ({ type: remoteTypes.get(path) ?? "file" }),
  } };

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
      showSaveDialog: async () => savePaths[saveCalls++] ?? null,
      selectDirectory: async () => { directoryCalls++; return "/batch"; },
      getSftpIdForConnection: () => "sftp-1",
      statSftp: async (_id, path) => ({
        name: path.split("/").at(-1) ?? "",
        type: remoteTypes.get(path) ?? "file",
        size: 3,
        lastModified: 0,
      }),
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const single = ops!.onDownloadFileLeft as unknown as (entry: SftpFileEntry, path?: string) => Promise<void>;
    const batch = ops!.onDownloadFilesLeft as unknown as (entries: SftpFileEntry[]) => Promise<void>;

    await act(async () => { await single(file("report.txt")); });
    await act(async () => { await single(file("report.txt")); });
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 1);
    assert.deepEqual(downloads.slice(0, 2).map((entry) => entry.targetPath), [
      "/downloads/renamed.txt", "/downloads/renamed.txt",
    ]);
    assert.equal(downloads[0].expectedLocalTarget, undefined);
    assert.equal(downloads[1].expectedLocalTarget?.targetIdentity, `${deviceId}:1000`);
    assert.equal(downloads[1].expectedLocalTarget?.targetBirthtimeNs, "1000000");
    assert.equal(downloads[2].expectedLocalTarget?.targetIdentity, `${deviceId}:1001`);

    await act(async () => { await single(file("report.txt"), "/other/report.txt"); });
    assert.equal(saveCalls, 2, "another remote source still opens Save As");

    existingFiles.delete("/downloads/renamed.txt");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 3, "a deleted target returns to Save As");

    existingFiles.set("/downloads/reselected.txt", "directory");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 4, "a target that changed type returns to Save As");

    realParents.set("/downloads", "/different-mount");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 5, "a redirected parent returns to Save As");

    realParents.set("/downloads", "/downloads");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 6);
    parentInodes.set("/downloads", 101);
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 7, "a changed mount beneath the same path returns to Save As");

    await act(async () => { await single(file("folder", "directory")); });
    await act(async () => { await batch([file("a"), file("b")]); });
    assert.equal(directoryCalls, 2, "folder and batch downloads still pick a directory");
    assert.equal(downloads.at(-1)?.targetPath, "/batch/b");

    endpointKey = "host-1:server-b:22:ssh::user:sftp";
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 8, "another endpoint with the same host ID still opens Save As");
    endpointKey = "host-1:server-a:22:ssh::user:sftp";
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 8, "the original endpoint retains only its own target");
    assert.equal(downloads.at(-1)?.targetPath, "/downloads/mount-reselected.txt");

    storage.set(STORAGE_KEY_SFTP_QUICK_DOWNLOAD, "false");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 9, "turning off the option restores Save As");
    storage.set(STORAGE_KEY_SFTP_QUICK_DOWNLOAD, "true");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 10, "the old target is forgotten while the option is disabled");
    assert.equal(downloads.at(-1)?.targetPath, "/downloads/re-enabled.txt");

    fileInodes.set("/downloads/re-enabled.txt", 99999);
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 11, "a different file at the remembered path returns to Save As");
    assert.equal(downloads.at(-1)?.targetPath, "/downloads/replaced-reselected.txt");

    const reusedPath = "/downloads/replaced-reselected.txt";
    fileBirthtimes.set(reusedPath, "9999999");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 12, "a new file reusing the same inode still opens Save As");
    assert.equal(downloads.at(-1)?.targetPath, "/downloads/reused-inode-reselected.txt");

    replaceAfterPublication = true;
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 12, "the published file initially uses the remembered destination");
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 13, "a file replaced after publication is never remembered");
    assert.equal(downloads.at(-1)?.targetPath, "/downloads/post-publication-reselected.txt");
    modifyAfterPublication = true;
    await act(async () => { await single(file("report.txt")); });
    await act(async () => { await single(file("report.txt")); });
    assert.equal(saveCalls, 14, "an in-place edit after publication is not remembered");
  } finally {
    await act(async () => { renderer?.unmount(); });
    (globalThis as { window?: unknown }).window = oldWindow;
    (globalThis as { localStorage?: unknown }).localStorage = oldStorage;
    globals.IS_REACT_ACT_ENVIRONMENT = oldAct;
  }
});
