import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { promoteDirectoryReplaceStage } from "./directoryReplacePromotion";

function createPathHarness(initialPaths: string[]) {
  const paths = new Set(initialPaths);
  const operations: string[] = [];
  return {
    paths,
    operations,
    statPath: async (candidate: string) => paths.has(candidate) ? { type: "directory" } : null,
    renamePath: async (source: string, target: string) => {
      operations.push(`rename:${source}->${target}`);
      if (!paths.has(source)) throw new Error(`ENOENT: ${source}`);
      if (paths.has(target)) throw new Error(`EEXIST: ${target}`);
      paths.delete(source);
      paths.add(target);
    },
    deletePath: async (candidate: string) => {
      operations.push(`delete:${candidate}`);
      if (!paths.delete(candidate)) throw new Error(`ENOENT: ${candidate}`);
    },
  };
}

const targetPath = "/target/final";
const stagedPath = "/target/final.netcatty-live.part";
const backupPath = "/target/final.netcatty-live.backup";

test("live directory replace restores an interrupted backup before retrying publication", async () => {
  const harness = createPathHarness([stagedPath, backupPath]);

  await promoteDirectoryReplaceStage({
    targetPath,
    stagedPath,
    backupPath,
    statPath: harness.statPath,
    renamePath: harness.renamePath,
    deletePath: harness.deletePath,
  });

  assert.equal(harness.operations[0], `rename:${backupPath}->${targetPath}`);
  assert.equal(harness.paths.has(targetPath), true);
  assert.equal(harness.paths.has(stagedPath), false);
  assert.equal(harness.paths.has(backupPath), false);
});

test("live directory replace stops when the existing target cannot be backed up", async () => {
  const harness = createPathHarness([targetPath, stagedPath]);
  const renamePath = async (source: string, target: string) => {
    harness.operations.push(`rename:${source}->${target}`);
    if (source === targetPath && target === backupPath) throw new Error("EACCES: backup denied");
    return harness.renamePath(source, target);
  };

  await assert.rejects(
    promoteDirectoryReplaceStage({
      targetPath,
      stagedPath,
      backupPath,
      statPath: harness.statPath,
      renamePath,
      deletePath: harness.deletePath,
    }),
    /backup denied/,
  );

  assert.equal(harness.paths.has(targetPath), true);
  assert.equal(harness.paths.has(stagedPath), true);
  assert.equal(harness.paths.has(backupPath), false);
  assert.equal(harness.operations.some((operation) => operation === `rename:${stagedPath}->${targetPath}`), false);
});

test("live directory replace retries transient backup cleanup", async () => {
  const harness = createPathHarness([targetPath, stagedPath]);
  let deleteAttempts = 0;
  const deletePath = async (candidate: string) => {
    deleteAttempts += 1;
    if (deleteAttempts < 3) throw new Error("EBUSY: backup locked");
    return harness.deletePath(candidate);
  };

  await promoteDirectoryReplaceStage({
    targetPath,
    stagedPath,
    backupPath,
    statPath: harness.statPath,
    renamePath: harness.renamePath,
    deletePath,
  });

  assert.equal(deleteAttempts, 3);
  assert.equal(harness.paths.has(targetPath), true);
  assert.equal(harness.paths.has(backupPath), false);
});

test("live directory replace keeps the committed target recoverable when backup cleanup persists", async () => {
  const harness = createPathHarness([targetPath, stagedPath]);
  let deleteAttempts = 0;

  await assert.rejects(
    promoteDirectoryReplaceStage({
      targetPath,
      stagedPath,
      backupPath,
      statPath: harness.statPath,
      renamePath: harness.renamePath,
      deletePath: async () => {
        deleteAttempts += 1;
        throw new Error("EPERM: backup retained");
      },
    }),
    /backup retained/,
  );

  assert.equal(deleteAttempts, 3);
  assert.equal(harness.paths.has(targetPath), true, "the new committed target remains published");
  assert.equal(harness.paths.has(backupPath), true, "the old tree remains available for recovery");
  assert.equal(harness.paths.has(stagedPath), false);
});

test("live and restart-resume directory replacement both call the shared promotion helper", () => {
  const liveSource = fs.readFileSync(new URL("./useSftpTransfers.ts", import.meta.url), "utf8");
  const resumeSource = fs.readFileSync(new URL("./dedicatedTransferResume.ts", import.meta.url), "utf8");
  assert.match(liveSource, /promoteDirectoryReplacePaths\(\{/);
  assert.match(resumeSource, /promoteDirectoryReplacePaths\(\{/);
});

test("live directory replacement bypasses the merge-only same-host copy shortcut", () => {
  const liveSource = fs.readFileSync(new URL("./useSftpTransfers.ts", import.meta.url), "utf8");
  const sameHostCopyGuard = liveSource.slice(
    liveSource.indexOf("if (\n        task.isDirectory"),
    liveSource.indexOf("sameHostCopyDirectory!", liveSource.indexOf("if (\n        task.isDirectory")),
  );

  assert.match(sameHostCopyGuard, /!task\.replaceExistingTarget/);
});
