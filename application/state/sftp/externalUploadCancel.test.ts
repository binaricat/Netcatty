import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("external upload cancellation is keyed by transfer task id", () => {
  const ops = readFileSync(new URL("./useSftpExternalOperations.ts", import.meta.url), "utf8");
  assert.match(ops, /uploadControllersByTaskRef/);
  assert.match(ops, /const cancelExternalUpload = useCallback\(async \(taskId\?: string\)/);
  assert.match(ops, /bindUploadControllerCallbacks/);

  const queue = readFileSync(
    new URL("../../../components/sftp/SftpTransferQueue.tsx", import.meta.url),
    "utf8",
  );
  assert.match(queue, /cancelExternalUpload\(task\.id\)/);
});

test("upload conflict cancel is scoped to owning controller", () => {
  const ops = readFileSync(new URL("./useSftpExternalOperations.ts", import.meta.url), "utf8");
  assert.match(ops, /uploadConflictOwnersRef/);
  assert.match(ops, /cancelPendingUploadConflicts = useCallback\(\(controller\?: UploadController\)/);
});
