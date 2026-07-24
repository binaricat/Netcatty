import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("USE_LOCAL conflict resolution forces upload-local without decrypting remote", () => {
  const source = readFileSync(new URL("./CloudSyncSettings.tsx", import.meta.url), "utf8");
  const useLocalIndex = source.indexOf("} else if (resolution === 'USE_LOCAL') {");
  const syncNowIndex = source.indexOf("results = await sync.syncNow(localPayload, {", useLocalIndex);
  const overrideShrinkIndex = source.indexOf("overrideShrink: true,", syncNowIndex);
  const uploadLocalIndex = source.indexOf("conflictActionOverride: 'upload-local',", syncNowIndex);
  const nextBranchIndex = source.indexOf("toast.success(t('cloudSync.resolve.uploaded'));", syncNowIndex);

  assert.notEqual(useLocalIndex, -1);
  assert.notEqual(syncNowIndex, -1);
  assert.notEqual(overrideShrinkIndex, -1);
  assert.notEqual(uploadLocalIndex, -1);
  assert.notEqual(nextBranchIndex, -1);
  assert.ok(
    useLocalIndex < syncNowIndex
      && syncNowIndex < overrideShrinkIndex
      && overrideShrinkIndex < uploadLocalIndex
      && uploadLocalIndex < nextBranchIndex,
    "keep-local must re-sync with conflictActionOverride upload-local so a new master password can overwrite an undecryptable cloud backup",
  );
});
