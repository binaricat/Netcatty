import assert from "node:assert/strict";
import test from "node:test";

import { reportSftpUploadResults } from "./reportSftpUploadResults.ts";

const t = (key: string, params?: Record<string, string | number>) => {
  if (key === "sftp.upload.partialSuccess") {
    return `partial ${params?.success}/${params?.failed}`;
  }
  return key;
};

test("does not toast success when zero files uploaded", () => {
  const calls: Array<{ type: string; message: string }> = [];
  reportSftpUploadResults({
    results: [],
    t,
    toast: {
      success: (message) => calls.push({ type: "success", message }),
      error: (message) => calls.push({ type: "error", message }),
      info: (message) => calls.push({ type: "info", message }),
    },
  });
  assert.deepEqual(calls, [{ type: "info", message: "sftp.upload.noFiles" }]);
});

test("toasts cancelled when any result is cancelled", () => {
  const calls: Array<{ type: string; message: string }> = [];
  reportSftpUploadResults({
    results: [
      { fileName: "a", success: false, cancelled: true },
      { fileName: "b", success: true },
    ],
    t,
    toast: {
      success: (message) => calls.push({ type: "success", message }),
      error: (message) => calls.push({ type: "error", message }),
      info: (message) => calls.push({ type: "info", message }),
    },
  });
  assert.deepEqual(calls, [{ type: "info", message: "sftp.upload.cancelled" }]);
});

test("toasts multi-file success count", () => {
  const calls: Array<{ type: string; message: string }> = [];
  reportSftpUploadResults({
    results: [
      { fileName: "a", success: true },
      { fileName: "b", success: true },
    ],
    t,
    toast: {
      success: (message) => calls.push({ type: "success", message }),
      error: (message) => calls.push({ type: "error", message }),
      info: (message) => calls.push({ type: "info", message }),
    },
  });
  assert.deepEqual(calls, [{ type: "success", message: "sftp.uploadFiles: 2" }]);
});

test("terminal drop success names the exact remote destination", () => {
  const calls: Array<{ type: string; message: string }> = [];
  reportSftpUploadResults({
    results: [{ fileName: "release.tgz", success: true }],
    targetPath: "/srv/releases",
    t,
    toast: {
      success: (message) => calls.push({ type: "success", message }),
      error: (message) => calls.push({ type: "error", message }),
      info: (message) => calls.push({ type: "info", message }),
    },
  });

  assert.deepEqual(calls, [{
    type: "success",
    message: "sftp.upload: release.tgz (/srv/releases)",
  }]);
});

test("toasts failures and partial success separately", () => {
  const calls: Array<{ type: string; message: string }> = [];
  reportSftpUploadResults({
    results: [
      { fileName: "a", success: true },
      { fileName: "b", success: false, error: "boom" },
    ],
    t,
    toast: {
      success: (message) => calls.push({ type: "success", message }),
      error: (message) => calls.push({ type: "error", message }),
      info: (message) => calls.push({ type: "info", message }),
    },
  });
  assert.equal(calls[0]?.type, "error");
  assert.equal(calls[1]?.type, "info");
  assert.match(calls[1]?.message ?? "", /partial 1\/1/);
});

test("partial terminal drop success names the exact remote destination", () => {
  const calls: Array<{ type: string; message: string }> = [];
  reportSftpUploadResults({
    results: [
      { fileName: "a", success: true },
      { fileName: "b", success: false, error: "boom" },
    ],
    targetPath: "/srv/releases",
    t,
    toast: {
      success: (message) => calls.push({ type: "success", message }),
      error: (message) => calls.push({ type: "error", message }),
      info: (message) => calls.push({ type: "info", message }),
    },
  });

  assert.deepEqual(calls[1], {
    type: "info",
    message: "partial 1/1 (/srv/releases)",
  });
});
