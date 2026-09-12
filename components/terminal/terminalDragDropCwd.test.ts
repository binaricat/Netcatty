import test from "node:test";
import assert from "node:assert/strict";

import type { DropEntry } from "../../lib/sftpFileUtils";
import type { Host } from "../../types";
import { TerminalDropNeedsSudoError } from "../../domain/sftpDropElevation";
import {
  ActiveTerminalCwdUnavailableError,
  DEFAULT_RZ_MISSING_FALLBACK_TIMEOUT_MS,
  handleTerminalDropEntries,
  resolveTerminalDropErrorMessage,
} from "./hooks/useTerminalDragDrop";
import { resolvePreferredTerminalCwd } from "./sftpCwd";

const host = {
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  port: 22,
  username: "alice",
  protocol: "ssh",
} as Host;

const dropEntries: DropEntry[] = [
  {
    file: null,
    relativePath: "report.txt",
    isDirectory: false,
  },
];

test("terminal drag-drop allows the full ZMODEM startup window before falling back", () => {
  assert.equal(DEFAULT_RZ_MISSING_FALLBACK_TIMEOUT_MS, 15_000);
});

test("terminal drag-drop shows actionable guidance when the active directory is unknown", () => {
  const requestedKeys: string[] = [];
  const message = resolveTerminalDropErrorMessage(
    new ActiveTerminalCwdUnavailableError(),
    (key) => {
      requestedKeys.push(key);
      return `translated:${key}`;
    },
  );

  assert.equal(message, "translated:terminal.dragDrop.destinationUnknown");
  assert.deepEqual(requestedKeys, ["terminal.dragDrop.destinationUnknown"]);
});

test("terminal drag-drop asks to enable sudo when /root is not writable as the login user", () => {
  const requestedKeys: string[] = [];
  const message = resolveTerminalDropErrorMessage(
    new TerminalDropNeedsSudoError(),
    (key) => {
      requestedKeys.push(key);
      return `translated:${key}`;
    },
  );

  assert.equal(message, "translated:terminal.dragDrop.needsSudoElevation");
  assert.deepEqual(requestedKeys, ["terminal.dragDrop.needsSudoElevation"]);
});

test("remote SSH terminal drop triggers ZMODEM drag-drop upload", async () => {
  let uploadedFiles: unknown;
  let uploadedSessionId: string | undefined;

  await handleTerminalDropEntries({
    dropEntries: [
      {
        file: {
          name: "report.txt",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as File,
        relativePath: "report.txt",
        isDirectory: false,
      },
    ],
    host,
    isLocalConnection: false,
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      startZmodemDragDropUpload: async (sessionId, files) => {
        uploadedSessionId = sessionId;
        uploadedFiles = files;
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(uploadedSessionId, "session-1");
  assert.equal(Array.isArray(uploadedFiles), true);
  const files = uploadedFiles as Array<{ name: string; remoteName: string; data?: ArrayBuffer }>;
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "report.txt");
  assert.equal(files[0].remoteName, "report.txt");
  assert.ok(files[0].data);
});

test("remote SSH terminal drop stays on ZMODEM when rz starts", async () => {
  let openedSftp = false;
  let zmodemCallback: ((event: { type: string; transferType?: string }) => void) | undefined;

  await handleTerminalDropEntries({
    dropEntries: [
      {
        file: {
          name: "report.txt",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as File,
        relativePath: "report.txt",
        isDirectory: false,
      },
    ],
    host,
    isLocalConnection: false,
    onOpenSftp: () => {
      openedSftp = true;
    },
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      cancelZmodem: () => {},
      onSessionData: () => () => {},
      onZmodemEvent: (_sessionId, cb) => {
        zmodemCallback = cb;
        return () => {
          zmodemCallback = undefined;
        };
      },
      startZmodemDragDropUpload: async (_sessionId, _files, uploadCommand) => {
        assert.match(uploadCommand ?? "", /NetcattyRzMissing=/);
        zmodemCallback?.({ type: "detect", transferType: "upload" });
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(openedSftp, false);
});

test("remote SSH terminal drop still waits for rz after the old 2.5 second deadline", async () => {
  let openedSftp = false;
  let zmodemCallback: ((event: { type: string; transferType?: string }) => void) | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{
      file: {
        name: "report.txt",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as File,
      relativePath: "report.txt",
      isDirectory: false,
    }],
    host,
    isLocalConnection: false,
    onOpenSftp: () => { openedSftp = true; },
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      cancelZmodem: () => {},
      onSessionData: () => () => {},
      onZmodemEvent: (_sessionId, cb) => {
        zmodemCallback = cb;
        return () => { zmodemCallback = undefined; };
      },
      startZmodemDragDropUpload: async () => {
        setTimeout(() => {
          zmodemCallback?.({ type: "detect", transferType: "upload" });
        }, 2_600);
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(openedSftp, false);
});

test("serial terminal drop does not wrap rz with an SSH shell fallback", async () => {
  let uploadCommandSeen: string | undefined;

  await handleTerminalDropEntries({
    dropEntries: [
      {
        file: {
          name: "report.txt",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as File,
        relativePath: "report.txt",
        isDirectory: false,
      },
    ],
    host: { ...host, protocol: "serial" } as Host,
    isLocalConnection: false,
    onOpenSftp: () => {},
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      cancelZmodem: () => {},
      onSessionData: () => () => {},
      startZmodemDragDropUpload: async (_sessionId, _files, uploadCommand) => {
        uploadCommandSeen = uploadCommand;
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(uploadCommandSeen, undefined);
});

test("telnet terminal drop does not wrap rz with an SSH shell fallback", async () => {
  let uploadCommandSeen: string | undefined;

  await handleTerminalDropEntries({
    dropEntries: [
      {
        file: {
          name: "report.txt",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as File,
        relativePath: "report.txt",
        isDirectory: false,
      },
    ],
    host: { ...host, protocol: "telnet" } as Host,
    isLocalConnection: false,
    onOpenSftp: () => {},
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      cancelZmodem: () => {},
      onSessionData: () => () => {},
      startZmodemDragDropUpload: async (_sessionId, _files, uploadCommand) => {
        uploadCommandSeen = uploadCommand;
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(uploadCommandSeen, undefined);
});

test("network device drop falls back to SFTP upload with a freshly resolved cwd", async () => {
  let receivedOptions: { preferFreshBackend?: boolean } | undefined;
  let openedPath: string | undefined;
  let openedEntries: DropEntry[] | undefined;
  let openedSessionId: string | undefined;

  await handleTerminalDropEntries({
    dropEntries,
    host,
    isLocalConnection: false,
    isNetworkDevice: true,
    onOpenSftp: (_host, initialPath, pendingUploadEntries, sourceSessionId) => {
      openedPath = initialPath;
      openedEntries = pendingUploadEntries;
      openedSessionId = sourceSessionId;
    },
    resolveSftpInitialPath: async (options) => {
      receivedOptions = options;
      return "/srv/app/current";
    },
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
    },
    termRef: { current: null },
  });

  assert.deepEqual(receivedOptions, {
    preferFreshBackend: true,
    requireActiveShellCwd: true,
  });
  assert.equal(openedPath, "/srv/app/current");
  assert.equal(openedEntries, dropEntries);
  assert.equal(openedSessionId, "session-1");
});

test("remote SSH terminal drop falls back to SFTP when rz is unavailable", async () => {
  let receivedOptions: { preferFreshBackend?: boolean } | undefined;
  let openedPath: string | undefined;
  let openedEntries: DropEntry[] | undefined;
  let openedSessionId: string | undefined;
  let dataCallback: ((chunk: string) => void) | undefined;
  let cancelled: { sessionId: string; interrupt?: boolean } | undefined;

  await handleTerminalDropEntries({
    dropEntries: [
      {
        file: {
          name: "report.txt",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as File,
        relativePath: "report.txt",
        isDirectory: false,
      },
    ],
    host,
    isLocalConnection: false,
    onOpenSftp: (_host, initialPath, pendingUploadEntries, sourceSessionId) => {
      openedPath = initialPath;
      openedEntries = pendingUploadEntries;
      openedSessionId = sourceSessionId;
    },
    resolveSftpInitialPath: async (options) => {
      receivedOptions = options;
      return "/srv/app/current";
    },
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      onSessionData: (_sessionId: string, cb: (chunk: string) => void) => {
        dataCallback = cb;
        return () => {
          dataCallback = undefined;
        };
      },
      cancelZmodem: (sessionId: string, options?: { interrupt?: boolean }) => {
        cancelled = { sessionId, interrupt: options?.interrupt };
      },
      startZmodemDragDropUpload: async (_sessionId, _files, uploadCommand) => {
        assert.match(uploadCommand ?? "", /NetcattyRzMissing=/);
        assert.equal((uploadCommand ?? "").includes("\u001b]1337;NetcattyRzMissing="), false);
        const token = uploadCommand?.match(/NetcattyRzMissing=([A-Za-z0-9_-]+)/)?.[1];
        assert.ok(token);
        dataCallback?.(`\u001b]1337;NetcattyRzMissing=${token}\u0007`);
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.deepEqual(receivedOptions, {
    preferFreshBackend: true,
    requireActiveShellCwd: true,
  });
  assert.equal(openedPath, "/srv/app/current");
  assert.equal(openedEntries?.length, 1);
  assert.equal(openedEntries?.[0].relativePath, "report.txt");
  assert.equal(openedSessionId, "session-1");
  assert.deepEqual(cancelled, { sessionId: "session-1", interrupt: false });
});

test("remote SSH terminal drop falls back to SFTP when rz never starts", async () => {
  let receivedOptions: { preferFreshBackend?: boolean } | undefined;
  let openedPath: string | undefined;
  let openedEntries: DropEntry[] | undefined;
  let cancelled: { sessionId: string; interrupt?: boolean } | undefined;

  await handleTerminalDropEntries({
    dropEntries: [
      {
        file: {
          name: "report.txt",
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as File,
        relativePath: "report.txt",
        isDirectory: false,
      },
    ],
    host,
    isLocalConnection: false,
    onOpenSftp: (_host, initialPath, pendingUploadEntries) => {
      openedPath = initialPath;
      openedEntries = pendingUploadEntries;
    },
    resolveSftpInitialPath: async (options) => {
      receivedOptions = options;
      return "/srv/app/current";
    },
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      onSessionData: () => () => {},
      cancelZmodem: (sessionId: string, options?: { interrupt?: boolean }) => {
        cancelled = { sessionId, interrupt: options?.interrupt };
      },
      startZmodemDragDropUpload: async () => ({ success: true }),
    },
    rzMissingFallbackTimeoutMs: 1,
    termRef: { current: null },
  });

  assert.deepEqual(receivedOptions, {
    preferFreshBackend: true,
    requireActiveShellCwd: true,
  });
  assert.equal(openedPath, "/srv/app/current");
  assert.equal(openedEntries?.length, 1);
  assert.deepEqual(cancelled, { sessionId: "session-1", interrupt: true });
});

test("remote SSH folder drop uses SFTP to preserve directory structure", async () => {
  let openedEntries: DropEntry[] | undefined;
  let originSessionId: string | undefined;
  let sourceSessionId: string | undefined;
  let zmodemStarted = false;

  const folderEntries: DropEntry[] = [
    {
      file: null,
      relativePath: "docs",
      isDirectory: true,
    },
    {
      file: {
        name: "guide.txt",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as File,
      relativePath: "docs/guide.txt",
      isDirectory: false,
    },
  ];

  await handleTerminalDropEntries({
    dropEntries: folderEntries,
    host,
    isLocalConnection: false,
    onOpenSftp: (_host, _initialPath, pendingUploadEntries, origin, source) => {
      openedEntries = pendingUploadEntries;
      originSessionId = origin;
      sourceSessionId = source;
    },
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: {
      writeToSession: () => {},
      startZmodemDragDropUpload: async () => {
        zmodemStarted = true;
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(zmodemStarted, false);
  assert.equal(openedEntries, folderEntries);
  assert.equal(originSessionId, "session-1");
  assert.equal(sourceSessionId, "session-1");
});

test("Mosh folder drop keeps its origin but opens a fresh SFTP route", async () => {
  let originSessionId: string | undefined;
  let sourceSessionId: string | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{ file: null, relativePath: "docs", isDirectory: true }],
    host: { ...host, moshEnabled: true },
    isLocalConnection: false,
    onOpenSftp: (_host, _path, _entries, origin, source) => {
      originSessionId = origin;
      sourceSessionId = source;
    },
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "mosh-session",
    sessionRef: { current: "mosh-session" },
    terminalBackend: { writeToSession: () => {} },
    termRef: { current: null },
  });

  assert.equal(originSessionId, "mosh-session");
  assert.equal(sourceSessionId, undefined);
});

test("ET rz fallback keeps its origin but opens a fresh SFTP route", async () => {
  let originSessionId: string | undefined;
  let sourceSessionId: string | undefined;
  let dataCallback: ((chunk: string) => void) | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{
      file: {
        name: "report.txt",
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      } as File,
      relativePath: "report.txt",
      isDirectory: false,
    }],
    host: { ...host, etEnabled: true },
    isLocalConnection: false,
    onOpenSftp: (_host, _path, _entries, origin, source) => {
      originSessionId = origin;
      sourceSessionId = source;
    },
    resolveSftpInitialPath: async () => "/srv/app/current",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "et-session",
    sessionRef: { current: "et-session" },
    terminalBackend: {
      writeToSession: () => {},
      onSessionData: (_sessionId, callback) => {
        dataCallback = callback;
        return () => { dataCallback = undefined; };
      },
      cancelZmodem: () => {},
      startZmodemDragDropUpload: async (_sessionId, _files, uploadCommand) => {
        const token = uploadCommand?.match(/NetcattyRzMissing=([A-Za-z0-9_-]+)/)?.[1];
        assert.ok(token);
        dataCallback?.(`\u001b]1337;NetcattyRzMissing=${token}\u0007`);
        return { success: true };
      },
    },
    termRef: { current: null },
  });

  assert.equal(originSessionId, "et-session");
  assert.equal(sourceSessionId, undefined);
});

test("remote SSH folder drop to /root reuses the saved host password for sudo SFTP", async () => {
  let openedHost: Host | undefined;
  let openedPath: string | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{ file: null, relativePath: "docs", isDirectory: true }],
    host: { ...host, password: "secret" },
    isLocalConnection: false,
    onOpenSftp: (nextHost, initialPath) => {
      openedHost = nextHost;
      openedPath = initialPath;
    },
    resolveSftpInitialPath: async () => "/root",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: { writeToSession: () => {} },
    termRef: { current: null },
  });

  assert.equal(openedPath, "/root");
  assert.equal(openedHost?.sftpSudo, true);
  assert.equal(openedHost?.password, "secret");
  assert.equal(host.sftpSudo, undefined);
});

test("remote SSH folder drop to /root uses a resolved identity username over a stale host username", async () => {
  let openedHost: Host | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{ file: null, relativePath: "docs", isDirectory: true }],
    host: { ...host, username: "root", password: "secret" },
    resolvedLoginUsername: "alice",
    resolvedSudoPassword: "secret",
    isLocalConnection: false,
    onOpenSftp: (nextHost) => {
      openedHost = nextHost;
    },
    resolveSftpInitialPath: async () => "/root",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: { writeToSession: () => {} },
    termRef: { current: null },
  });

  assert.equal(openedHost?.sftpSudo, true);
});

test("remote SSH folder drop to /root uses a resolved identity password", async () => {
  let openedHost: Host | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{ file: null, relativePath: "docs", isDirectory: true }],
    host: { ...host, identityId: "id-1" },
    resolvedSudoPassword: "identity-secret",
    isLocalConnection: false,
    onOpenSftp: (nextHost) => {
      openedHost = nextHost;
    },
    resolveSftpInitialPath: async () => "/root",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: { writeToSession: () => {} },
    termRef: { current: null },
  });

  assert.equal(openedHost?.sftpSudo, true);
  assert.equal(openedHost?.password, undefined);
  assert.equal(openedHost?.identityId, "id-1");
});

test("remote SSH folder drop to /root fails closed without a saved sudo password", async () => {
  let openedSftp = false;

  await assert.rejects(
    handleTerminalDropEntries({
      dropEntries: [{ file: null, relativePath: "docs", isDirectory: true }],
      host,
      isLocalConnection: false,
      onOpenSftp: () => {
        openedSftp = true;
      },
      resolveSftpInitialPath: async () => "/root",
      scrollToBottomAfterProgrammaticInput: () => {},
      sessionId: "session-1",
      sessionRef: { current: "session-1" },
      terminalBackend: { writeToSession: () => {} },
      termRef: { current: null },
    }),
    TerminalDropNeedsSudoError,
  );

  assert.equal(openedSftp, false);
});

test("remote SSH folder drop to the login home does not enable sudo", async () => {
  let openedHost: Host | undefined;

  await handleTerminalDropEntries({
    dropEntries: [{ file: null, relativePath: "docs", isDirectory: true }],
    host: { ...host, password: "secret" },
    isLocalConnection: false,
    onOpenSftp: (nextHost) => {
      openedHost = nextHost;
    },
    resolveSftpInitialPath: async () => "/home/alice",
    scrollToBottomAfterProgrammaticInput: () => {},
    sessionId: "session-1",
    sessionRef: { current: "session-1" },
    terminalBackend: { writeToSession: () => {} },
    termRef: { current: null },
  });

  assert.equal(openedHost?.sftpSudo, undefined);
});

test("remote SSH folder drop refuses to guess a destination when the active shell cwd is unknown", async () => {
  let openedSftp = false;
  let receivedOptions: unknown;

  await assert.rejects(
    handleTerminalDropEntries({
      dropEntries: [
        {
          file: null,
          relativePath: "docs",
          isDirectory: true,
        },
      ],
      host,
      isLocalConnection: false,
      onOpenSftp: () => {
        openedSftp = true;
      },
      resolveSftpInitialPath: async (options) => {
        receivedOptions = options;
        return undefined;
      },
      scrollToBottomAfterProgrammaticInput: () => {},
      sessionId: "session-1",
      sessionRef: { current: "session-1" },
      terminalBackend: {
        writeToSession: () => {},
      },
      termRef: { current: null },
    }),
    /Could not determine the active terminal directory/,
  );

  assert.deepEqual(receivedOptions, {
    preferFreshBackend: true,
    requireActiveShellCwd: true,
  });
  assert.equal(openedSftp, false);
});

test("fresh cwd resolution falls back to the renderer cwd when backend probe has no real cwd", async () => {
  const cwd = await resolvePreferredTerminalCwd({
    rendererCwd: "/srv/app/current",
    sessionId: "session-1",
    preferFreshBackend: true,
    getSessionPwd: async (_sessionId, options) => {
      assert.deepEqual(options, {
        allowHomeFallback: false,
        allowLoginShellFallback: true,
      });
      return { success: false, error: "Could not determine cwd" };
    },
  });

  assert.equal(cwd, "/srv/app/current");
});
