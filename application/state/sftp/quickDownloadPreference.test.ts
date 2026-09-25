import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SFTP_QUICK_DOWNLOAD,
  isSftpQuickDownloadPlatformSupported,
  resolveSftpQuickDownloadEnabled,
} from "./quickDownloadPreference";

test("defaults quick download to disabled", () => {
  assert.equal(resolveSftpQuickDownloadEnabled(null), DEFAULT_SFTP_QUICK_DOWNLOAD);
  assert.equal(resolveSftpQuickDownloadEnabled(undefined), DEFAULT_SFTP_QUICK_DOWNLOAD);
  assert.equal(DEFAULT_SFTP_QUICK_DOWNLOAD, false);
});

test("keeps an explicit quick download preference", () => {
  assert.equal(resolveSftpQuickDownloadEnabled(true), true);
  assert.equal(resolveSftpQuickDownloadEnabled(false), false);
});

test("supports the quick download preference outside Windows", () => {
  assert.equal(isSftpQuickDownloadPlatformSupported(), true);
});
