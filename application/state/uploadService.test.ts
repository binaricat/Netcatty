import test from "node:test";
import assert from "node:assert/strict";

import { uploadFromDataTransfer } from "../../lib/uploadService.ts";

function createDataTransfer(files: File[]): DataTransfer {
  return {
    items: { length: 0 },
    files,
  } as unknown as DataTransfer;
}

test("clears the scanning placeholder when every dropped file is skipped by conflict resolution", async () => {
  const events: string[] = [];
  const file = new File(["local"], "conflict.txt", { lastModified: 1234 });

  const results = await uploadFromDataTransfer(
    createDataTransfer([file]),
    {
      targetPath: "/target",
      sftpId: null,
      isLocal: true,
      bridge: {
        mkdirSftp: async () => {},
        statLocal: async () => ({ type: "file", size: 10, lastModified: 1000 }),
        writeLocalFile: async () => {
          throw new Error("skipped conflicts should not upload");
        },
      },
      joinPath: (base, name) => `${base}/${name}`,
      callbacks: {
        onScanningStart: () => events.push("scan:start"),
        onScanningEnd: () => events.push("scan:end"),
        onTaskCreated: () => events.push("task:create"),
      },
      resolveConflict: async () => "skip",
    },
  );

  assert.deepEqual(results, [
    { fileName: "conflict.txt", success: false, cancelled: true },
  ]);
  assert.deepEqual(events, ["scan:start", "scan:end"]);
});
