import test from "node:test";
import assert from "node:assert/strict";

import type { SftpPane } from "../../application/state/sftp/types.ts";
import { getSftpTabDuplicateRequest } from "./sftpTabDuplication.ts";

const connectedPane = (overrides: Partial<NonNullable<SftpPane["connection"]>> = {}): SftpPane => ({
  id: "tab-1",
  connection: {
    id: "conn-1",
    hostId: "host-1",
    hostLabel: "Prod",
    isLocal: false,
    status: "connected",
    currentPath: "/var/www/app",
    homeDir: "/home/deploy",
    ...overrides,
  },
  files: [],
  loading: false,
  reconnecting: false,
  error: null,
  connectionLogs: [],
  selectedFiles: new Set(),
  filter: "",
  filenameEncoding: "auto",
  showHiddenFiles: false,
  transferMutationToken: 0,
});

test("default-path SFTP tab duplication keeps only the remote host identity", () => {
  assert.deepEqual(getSftpTabDuplicateRequest(connectedPane(), "defaultPath"), {
    kind: "remote",
    hostId: "host-1",
  });
});

test("current-path SFTP tab duplication carries the active directory", () => {
  assert.deepEqual(getSftpTabDuplicateRequest(connectedPane(), "currentPath"), {
    kind: "remote",
    hostId: "host-1",
    path: "/var/www/app",
  });
});

test("local SFTP tab duplication targets the local filesystem", () => {
  assert.deepEqual(
    getSftpTabDuplicateRequest(
      connectedPane({
        hostId: "local",
        hostLabel: "Local",
        isLocal: true,
        currentPath: "/Users/damao/projects",
        homeDir: "/Users/damao",
      }),
      "currentPath",
    ),
    {
      kind: "local",
      path: "/Users/damao/projects",
    },
  );
});

test("SFTP tab duplication is unavailable before a tab is connected", () => {
  assert.equal(getSftpTabDuplicateRequest({ ...connectedPane(), connection: null }, "defaultPath"), null);
  assert.equal(
    getSftpTabDuplicateRequest(connectedPane({ status: "connecting" }), "currentPath"),
    null,
  );
});
