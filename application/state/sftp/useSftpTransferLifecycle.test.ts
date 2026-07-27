// 创建时间: 2026-07-27
// 功能说明: 验证 SFTP 传输连接池预热策略，避免后台触发二次认证。

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
