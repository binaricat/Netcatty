import test from "node:test";
import assert from "node:assert/strict";

import {
  getNextSftpListDensity,
  getSftpListDensityToggleLabelKey,
  parseSftpListDensity,
  sftpFileRowDensityClass,
} from "./sftpListDensity.ts";

test("parseSftpListDensity falls back to comfortable", () => {
  assert.equal(parseSftpListDensity("compact"), "compact");
  assert.equal(parseSftpListDensity("comfortable"), "comfortable");
  assert.equal(parseSftpListDensity("nope"), "comfortable");
  assert.equal(parseSftpListDensity(null), "comfortable");
});

test("list density toggle flips compact and comfortable", () => {
  assert.equal(getNextSftpListDensity("comfortable"), "compact");
  assert.equal(getNextSftpListDensity("compact"), "comfortable");
  assert.equal(
    getSftpListDensityToggleLabelKey("comfortable"),
    "sftp.listDensity.switchToCompact",
  );
  assert.ok(sftpFileRowDensityClass("compact").includes("py-0.5"));
  assert.ok(sftpFileRowDensityClass("comfortable").includes("py-2"));
});
