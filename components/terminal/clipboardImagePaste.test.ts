import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRemoteClipboardImagePath,
  handleRemoteClipboardImagePaste,
  quoteRemotePathForShell,
} from "./clipboardImagePaste";

test("remote clipboard image path is placed under the current directory", () => {
  assert.equal(
    buildRemoteClipboardImagePath("/srv/app", "netcatty paste:1.png"),
    "/srv/app/.netcatty-paste-images/netcatty_paste_1.png",
  );
});

test("remote clipboard image path is empty when cwd is unavailable", () => {
  assert.equal(
    buildRemoteClipboardImagePath(undefined, "shot.png"),
    "",
  );
});

test("remote paths are quoted for shell-safe insertion", () => {
  assert.equal(
    quoteRemotePathForShell("/srv/app/.netcatty-paste-images/a b's.png"),
    "'/srv/app/.netcatty-paste-images/a b'\\''s.png'",
  );
});

test("remote clipboard image paste uploads and inserts the remote image path without broadcasting", async () => {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const scrolled: string[] = [];
  let focused = false;
  let closedSftpId: string | undefined;
  let deletedTempFile: string | undefined;
  const transferPayloads: unknown[] = [];
  const broadcastData: string[] = [];

  const handled = await handleRemoteClipboardImagePaste({
    bridge: {
      readClipboardImage: async () => ({
        path: "/tmp/netcatty/shot.png",
        name: "shot 1.png",
        mediaType: "image/png",
        size: 12,
      }),
      openSftpForSession: async (sessionId) => {
        assert.equal(sessionId, "session-1");
        return "sftp-1";
      },
      startStreamTransfer: async (options) => {
        transferPayloads.push(options);
        return { transferId: options.transferId, totalBytes: 12 };
      },
      closeSftp: async (sftpId) => {
        closedSftpId = sftpId;
      },
      deleteTempFile: async (filePath) => {
        deletedTempFile = filePath;
        return { success: true };
      },
    },
    createTransferId: () => "transfer-1",
    getRemoteCwd: async () => "/home/alice/project",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    },
    term: {
      focus: () => {
        focused = true;
      },
    },
    scrollToBottomAfterProgrammaticInput: (data) => scrolled.push(data),
  });

  assert.equal(handled, true);
  assert.deepEqual(transferPayloads, [
    {
      transferId: "transfer-1",
      sourcePath: "/tmp/netcatty/shot.png",
      targetPath: "/home/alice/project/.netcatty-paste-images/shot_1.png",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "sftp-1",
      totalBytes: 12,
    },
  ]);
  assert.deepEqual(writes, [
    {
      sessionId: "session-1",
      data: "/home/alice/project/.netcatty-paste-images/shot_1.png",
    },
  ]);
  assert.deepEqual(scrolled, ["/home/alice/project/.netcatty-paste-images/shot_1.png"]);
  assert.deepEqual(broadcastData, []);
  assert.equal(focused, true);
  assert.equal(closedSftpId, "sftp-1");
  assert.equal(deletedTempFile, "/tmp/netcatty/shot.png");
});

test("remote clipboard image paste reports unhandled when no image exists", async () => {
  const handled = await handleRemoteClipboardImagePaste({
    bridge: {
      readClipboardImage: async () => null,
      openSftpForSession: async () => "sftp-1",
      startStreamTransfer: async (options) => ({ transferId: options.transferId }),
    },
    getRemoteCwd: async () => "/home/alice",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("should not paste without an image"),
    },
  });

  assert.equal(handled, false);
});

test("remote clipboard image paste skips upload without a reliable cwd", async () => {
  const transferPayloads: unknown[] = [];
  let deletedTempFile: string | undefined;

  const handled = await handleRemoteClipboardImagePaste({
    bridge: {
      readClipboardImage: async () => ({
        path: "/tmp/netcatty/shot.png",
        name: "shot.png",
        mediaType: "image/png",
        size: 12,
      }),
      openSftpForSession: async () => {
        assert.fail("should not open SFTP without cwd");
      },
      startStreamTransfer: async (options) => {
        transferPayloads.push(options);
        return { transferId: options.transferId };
      },
      deleteTempFile: async (filePath) => {
        deletedTempFile = filePath;
        return { success: true };
      },
    },
    getRemoteCwd: async () => undefined,
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("should not paste without upload"),
    },
  });

  assert.equal(handled, false);
  assert.deepEqual(transferPayloads, []);
  assert.equal(deletedTempFile, "/tmp/netcatty/shot.png");
});

test("remote clipboard image paste does not insert a path when upload returns an error", async () => {
  let closedSftpId: string | undefined;
  let deletedTempFile: string | undefined;

  const handled = await handleRemoteClipboardImagePaste({
    bridge: {
      readClipboardImage: async () => ({
        path: "/tmp/netcatty/shot.png",
        name: "shot.png",
        mediaType: "image/png",
        size: 12,
      }),
      openSftpForSession: async () => "sftp-1",
      startStreamTransfer: async (options) => ({ transferId: options.transferId, error: "disk full" }),
      closeSftp: async (sftpId) => {
        closedSftpId = sftpId;
      },
      deleteTempFile: async (filePath) => {
        deletedTempFile = filePath;
        return { success: true };
      },
    },
    getRemoteCwd: async () => "/home/alice",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("should not paste failed upload path"),
    },
  });

  assert.equal(handled, false);
  assert.equal(closedSftpId, "sftp-1");
  assert.equal(deletedTempFile, "/tmp/netcatty/shot.png");
});
