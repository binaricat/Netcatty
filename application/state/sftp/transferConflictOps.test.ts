import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { SftpPane } from "./types";
import { useSftpTransferConflictOps } from "./transferConflictOps";

test("bind-mounted parents cannot cause replacement to delete the source link", async (t) => {
  const originalGet = netcattyBridge.get;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  let ops!: ReturnType<typeof useSftpTransferConflictOps>;
  let deletes = 0;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    netcattyBridge.get = originalGet;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  });
  netcattyBridge.get = () => ({
    // Bind mounts retain different realpaths but expose the same parent identity.
    realpathLocal: async (value: string) => value,
    statLocal: async (value: string) => ({
      type: "directory", size: 0, lastModified: 0, dev: 42,
      ino: value === "/a" || value === "/mnt/alias" ? 7 : 8,
    }),
    deleteLocalFile: async () => { deletes++; },
  } as unknown as NetcattyBridge);
  function Probe() { ops = useSftpTransferConflictOps(); return null; }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const pane = { connection: { id: "local-pane", isLocal: true } } as SftpPane;
  const task = {
    sourceConnectionId: "local-pane", targetConnectionId: "local-pane",
    sourcePath: "/a/link", targetPath: "/mnt/alias/link", fileName: "link", isDirectory: false,
  } as TransferTask;
  await assert.rejects(ops.deleteTargetPath(task, pane, null, "auto", "symlink"), /Choose Duplicate or Skip/);
  assert.equal(deletes, 0);
  assert.equal(await ops.isSameSourceEntry(task, pane, null, "auto"), true);
  // Different entries and genuinely different parents must remain replaceable.
  for (const targetPath of ["/mnt/alias/another-link", "/other/link"]) {
    const other = { ...task, targetPath };
    assert.equal(await ops.isSameSourceEntry(other, pane, null, "auto"), false);
    await ops.deleteTargetPath(other, pane, null, "auto", "symlink");
  }
  assert.equal(deletes, 2);
});

test("same-pane link replacement preserves the source, including aliased parent paths", async (t) => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".pr3318-links-"));
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const originalGet = netcattyBridge.get;
  let renderer: ReactTestRenderer;
  let ops!: ReturnType<typeof useSftpTransferConflictOps>;
  let deletes = 0;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    netcattyBridge.get = originalGet;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, "source"));
  await fs.mkdir(path.join(dir, "other"));
  await fs.writeFile(path.join(dir, "source", "file"), "keep original contents");
  await fs.symlink("file", path.join(dir, "source", "link"));
  await fs.symlink("source", path.join(dir, "alias"));
  netcattyBridge.get = () => ({
    realpathLocal: fs.realpath,
    lstatLocal: async (value: string) => {
      const stat = await fs.lstat(value);
      return { type: stat.isSymbolicLink() ? "symlink" : "file", size: stat.size, lastModified: stat.mtimeMs };
    },
    deleteLocalFile: async (value: string) => { deletes++; await fs.unlink(value); },
  } as unknown as NetcattyBridge);
  function Probe() { ops = useSftpTransferConflictOps(); return null; }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const pane = { connection: { id: "local-pane", isLocal: true } } as SftpPane;
  const task = {
    sourceConnectionId: "local-pane", targetConnectionId: "local-pane",
    sourcePath: path.join(dir, "source", "link"),
    targetPath: path.join(dir, "source", "link"),
    fileName: "link", isDirectory: false,
  } as TransferTask;
  for (const parent of ["source", "alias", "source/."]) {
    await assert.rejects(ops.deleteTargetPath(
      { ...task, targetPath: `${dir}/${parent}/link` }, pane, null, "auto", "symlink",
    ), /Choose Duplicate or Skip/);
    assert.equal(await fs.readlink(task.sourcePath), "file");
    assert.equal(await fs.readFile(task.sourcePath, "utf8"), "keep original contents");
  }
  assert.equal(deletes, 0);
  const duplicate = await ops.getDuplicateTarget(task, pane, null, "auto");
  assert.equal(duplicate.fileName, "link (copy)");
  await fs.symlink("../source/file", path.join(dir, "other", "link"));
  await ops.deleteTargetPath({ ...task, targetPath: path.join(dir, "other", "link") }, pane, null, "auto", "symlink");
  assert.equal(deletes, 1);
  assert.equal(await fs.readlink(task.sourcePath), "file");
});
