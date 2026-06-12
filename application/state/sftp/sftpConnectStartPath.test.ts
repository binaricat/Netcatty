import test from "node:test";
import assert from "node:assert/strict";

import type { RemoteSftpStartCache } from "./sftpConnectStartPath.ts";
import {
  normalizeSftpInitialPath,
  resolveRemoteSftpStartState,
} from "./sftpConnectStartPath.ts";

const cached: RemoteSftpStartCache = {
  path: "/var/cache",
  homeDir: "/home/deploy",
  files: [],
  filenameEncoding: "auto",
};

test("remote SFTP default-path duplication ignores the shared host cache", () => {
  const state = resolveRemoteSftpStartState({
    filenameEncoding: "auto",
    ignoreSharedCache: true,
    sharedHostCacheCandidate: cached,
  });

  assert.equal(state.initialPath, undefined);
  assert.equal(state.sharedHostCache, null);
  assert.equal(state.cachedStartPath, "/");
});

test("remote SFTP current-path duplication uses the requested path instead of stale cache", () => {
  const state = resolveRemoteSftpStartState({
    filenameEncoding: "auto",
    initialPath: "/var/www/app",
    sharedHostCacheCandidate: cached,
  });

  assert.equal(state.initialPath, "/var/www/app");
  assert.equal(state.sharedHostCache, null);
  assert.equal(state.cachedStartPath, "/var/www/app");
});

test("remote SFTP initial paths preserve meaningful whitespace", () => {
  assert.equal(normalizeSftpInitialPath("/var/www/app "), "/var/www/app ");

  const state = resolveRemoteSftpStartState({
    filenameEncoding: "auto",
    initialPath: "/var/www/app ",
    sharedHostCacheCandidate: {
      ...cached,
      path: "/var/www/app",
    },
  });

  assert.equal(state.initialPath, "/var/www/app ");
  assert.equal(state.sharedHostCache, null);
  assert.equal(state.cachedStartPath, "/var/www/app ");
});
