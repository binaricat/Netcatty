// Created: 2026-07-27
// Purpose: Verify SFTP transfer pool warmup policy avoids background MFA prompts.

import assert from "node:assert/strict";
import test from "node:test";

import { getWarmSftpTransferPoolHostIds } from "./useSftpTransferLifecycle.ts";

test("transfer pool warmup is disabled by default to avoid background MFA prompts", () => {
  assert.deepEqual(
    getWarmSftpTransferPoolHostIds({
      hostIds: ["host-b", "host-a"],
      activeHostId: "host-c",
    }),
    [],
  );
});

test("transfer pool warmup deduplicates hosts when explicitly enabled", () => {
  assert.deepEqual(
    getWarmSftpTransferPoolHostIds({
      hostIds: ["host-b", "host-a", "host-b"],
      activeHostId: "host-a",
      enabled: true,
    }),
    ["host-a", "host-b"],
  );
});
