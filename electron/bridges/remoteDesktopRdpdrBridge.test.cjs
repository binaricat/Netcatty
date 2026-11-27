"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  NTSTATUS,
  CREATE_DISPOSITION,
  CREATE_INFORMATION,
  CREATE_OPTIONS,
  DESIRED_ACCESS,
  FILE_ATTRIBUTES,
  FILE_INFO_CLASS,
  FS_INFO_CLASS,
  FS_ATTRIBUTES,
  MAX_READ_BYTES,
  unixMsToFiletimeString,
  filetimeToUnixSeconds,
  matchWindowsWildcard,
  createRemoteDesktopRdpdrBridge,
  registerRdpdrHandlers,
} = require("./remoteDesktopRdpdrBridge.cjs");

function createTempSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nc-rdpdr-test-"));
  const driveRoot = path.join(base, "share");
  const outsideDir = path.join(base, "outside");
  fs.mkdirSync(driveRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP-SECRET");
  return {
    base,
    driveRoot,
    outsideDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe("remoteDesktopRdpdrBridge helpers (FILETIME & Windows wildcards)", () => {
  it("converts unix ms <-> Windows FILETIME decimal strings without precision loss", () => {
    const ms = Date.UTC(2026, 5, 15, 12, 30, 45, 500);
    const ft = unixMsToFiletimeString(ms);
    assert.match(ft, /^\d+$/);
    // Must exceed Number.MAX_SAFE_INTEGER (64-bit FILETIME)
    assert.ok(BigInt(ft) > BigInt(Number.MAX_SAFE_INTEGER));
    const roundTrippedSec = filetimeToUnixSeconds(ft);
    assert.ok(Math.abs(roundTrippedSec - ms / 1000) < 0.001);
    // 0 and -1 mean "do not modify" per MS-FSA
    assert.equal(filetimeToUnixSeconds("0"), null);
    assert.equal(filetimeToUnixSeconds("-1"), null);
    assert.equal(filetimeToUnixSeconds(0), null);
  });

  it("matches Windows wildcards (*, ?, *.*, trailing .*, case-insensitive)", () => {
    assert.equal(matchWindowsWildcard("README", "*.*"), true);
    assert.equal(matchWindowsWildcard("notes.txt", "*.*"), true);
    assert.equal(matchWindowsWildcard("Notes.TXT", "*.txt"), true);
    assert.equal(matchWindowsWildcard("note1.txt", "note?.txt"), true);
    assert.equal(matchWindowsWildcard("note12.txt", "note?.txt"), false);
    assert.equal(matchWindowsWildcard("report", "report.*"), true);
    assert.equal(matchWindowsWildcard("report.pdf", "report.*"), true);
    assert.equal(matchWindowsWildcard("other.pdf", "report.*"), false);
  });
});

describe("remoteDesktopRdpdrBridge path jail & symlink escape protection", () => {
  it("rejects .., NUL, ADS colons, outside symlinks, broken symlinks, and escaping renames with STATUS_ACCESS_DENIED", async () => {
    const sb = createTempSandbox();
    const bridge = createRemoteDesktopRdpdrBridge();
    try {
      const reg = await bridge.registerDrives("s-jail", [
        { deviceId: 10, name: "Shared", path: sb.driveRoot, readOnly: false },
      ]);
      assert.equal(reg.ok, true);
      assert.equal(reg.registered.length, 1);

      // Create symlinks inside share: one escaping, one broken, one valid internal
      fs.writeFileSync(path.join(sb.driveRoot, "inside.txt"), "hello-inside");
      fs.symlinkSync(path.join(sb.outsideDir, "secret.txt"), path.join(sb.driveRoot, "escape-file.txt"));
      fs.symlinkSync(sb.outsideDir, path.join(sb.driveRoot, "escape-dir"));
      fs.symlinkSync(path.join(sb.outsideDir, "nonexistent.txt"), path.join(sb.driveRoot, "broken-link.txt"));
      fs.symlinkSync(path.join(sb.driveRoot, "inside.txt"), path.join(sb.driveRoot, "good-link.txt"));

      const badPaths = [
        "\\..\\outside\\secret.txt",
        "sub\\..\\..\\outside\\secret.txt",
        "../outside/secret.txt",
        "\\bad\0name.txt",
        "\\inside.txt:Zone.Identifier",
        "\\escape-file.txt",
        "\\escape-dir\\secret.txt",
        "\\escape-dir\\new-file.txt",
        "\\broken-link.txt",
      ];

      for (const p of badPaths) {
        const res = await bridge.handleOp("s-jail", {
          op: "create",
          deviceId: 10,
          fileId: 0,
          completionId: 1,
          path: p,
          desiredAccess: DESIRED_ACCESS.GENERIC_READ | DESIRED_ACCESS.GENERIC_WRITE,
          createDisposition: CREATE_DISPOSITION.FILE_OPEN_IF,
          createOptions: 0,
        });
        assert.equal(
          res.status,
          NTSTATUS.ACCESS_DENIED,
          `Expected ACCESS_DENIED for path ${JSON.stringify(p)}, got 0x${res.status.toString(16)}`,
        );
      }

      // Internal symlink pointing inside jail is permitted
      const okLink = await bridge.handleOp("s-jail", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 2,
        path: "\\good-link.txt",
        desiredAccess: DESIRED_ACCESS.GENERIC_READ,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: 0,
      });
      assert.equal(okLink.status, NTSTATUS.SUCCESS);
      const readLink = await bridge.handleOp("s-jail", {
        op: "read",
        deviceId: 10,
        fileId: okLink.fileId,
        completionId: 3,
        offset: 0,
        length: 64,
      });
      assert.equal(readLink.status, NTSTATUS.SUCCESS);
      assert.equal(Buffer.from(readLink.data).toString("utf8"), "hello-inside");
      await bridge.handleOp("s-jail", { op: "close", deviceId: 10, fileId: okLink.fileId, completionId: 4 });

      // Query directory must NOT leak escaping symlinks
      const rootDir = await bridge.handleOp("s-jail", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 5,
        path: "\\",
        desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
      });
      assert.equal(rootDir.status, NTSTATUS.SUCCESS);
      const listed = [];
      let initial = true;
      for (;;) {
        const q = await bridge.handleOp("s-jail", {
          op: "query_directory",
          deviceId: 10,
          fileId: rootDir.fileId,
          completionId: 6,
          initialQuery: initial,
          informationClass: FILE_INFO_CLASS.BOTH_DIRECTORY,
          path: "\\*",
        });
        initial = false;
        if (q.status === NTSTATUS.NO_MORE_FILES) break;
        assert.equal(q.status, NTSTATUS.SUCCESS);
        listed.push(q.entry.fileName);
      }
      assert.ok(listed.includes("inside.txt"));
      assert.ok(listed.includes("good-link.txt"));
      assert.ok(!listed.includes("escape-file.txt"));
      assert.ok(!listed.includes("escape-dir"));
      assert.ok(!listed.includes("broken-link.txt"));
      await bridge.handleOp("s-jail", { op: "close", deviceId: 10, fileId: rootDir.fileId, completionId: 7 });

      // Rename escaping jail must be rejected
      const openInside = await bridge.handleOp("s-jail", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 8,
        path: "\\inside.txt",
        desiredAccess: DESIRED_ACCESS.DELETE | DESIRED_ACCESS.GENERIC_READ,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: 0,
      });
      assert.equal(openInside.status, NTSTATUS.SUCCESS);
      const badRename = await bridge.handleOp("s-jail", {
        op: "set_information",
        deviceId: 10,
        fileId: openInside.fileId,
        completionId: 9,
        informationClass: FILE_INFO_CLASS.RENAME,
        renameTarget: "\\..\\outside\\pwned.txt",
        replaceIfExists: true,
      });
      assert.equal(badRename.status, NTSTATUS.ACCESS_DENIED);
      const badRenameViaLink = await bridge.handleOp("s-jail", {
        op: "set_information",
        deviceId: 10,
        fileId: openInside.fileId,
        completionId: 10,
        informationClass: FILE_INFO_CLASS.RENAME,
        renameTarget: "\\escape-dir\\pwned.txt",
        replaceIfExists: true,
      });
      assert.equal(badRenameViaLink.status, NTSTATUS.ACCESS_DENIED);
      await bridge.handleOp("s-jail", { op: "close", deviceId: 10, fileId: openInside.fileId, completionId: 11 });
    } finally {
      await bridge.cleanupAll();
      sb.cleanup();
    }
  });
});

describe("remoteDesktopRdpdrBridge read-only drive protection", () => {
  it("allows reads/listings/metadata and rejects all mutations with STATUS_MEDIA_WRITE_PROTECTED", async () => {
    const sb = createTempSandbox();
    const bridge = createRemoteDesktopRdpdrBridge();
    try {
      fs.writeFileSync(path.join(sb.driveRoot, "readonly.txt"), "immutable-data");
      await bridge.registerDrives("s-ro", [
        { deviceId: 11, name: "ReadOnlyShare", path: sb.driveRoot, readOnly: true },
      ]);

      // Opening existing file with MAXIMUM_ALLOWED works in read-only mode
      const opened = await bridge.handleOp("s-ro", {
        op: "create",
        deviceId: 11,
        fileId: 0,
        completionId: 1,
        path: "\\readonly.txt",
        desiredAccess: DESIRED_ACCESS.MAXIMUM_ALLOWED,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: 0,
      });
      assert.equal(opened.status, NTSTATUS.SUCCESS);

      const readRes = await bridge.handleOp("s-ro", {
        op: "read",
        deviceId: 11,
        fileId: opened.fileId,
        completionId: 2,
        offset: 0,
        length: 32,
      });
      assert.equal(readRes.status, NTSTATUS.SUCCESS);
      assert.equal(Buffer.from(readRes.data).toString("utf8"), "immutable-data");

      // Query info reports FILE_ATTRIBUTE_READONLY, volume attribute reports FILE_READ_ONLY_VOLUME
      const basic = await bridge.handleOp("s-ro", {
        op: "query_information",
        deviceId: 11,
        fileId: opened.fileId,
        completionId: 3,
        informationClass: FILE_INFO_CLASS.BASIC,
      });
      assert.equal(basic.status, NTSTATUS.SUCCESS);
      assert.ok((basic.basic.fileAttributes & FILE_ATTRIBUTES.READONLY) !== 0);

      const volAttr = await bridge.handleOp("s-ro", {
        op: "query_volume_information",
        deviceId: 11,
        fileId: opened.fileId,
        completionId: 4,
        informationClass: FS_INFO_CLASS.ATTRIBUTE,
      });
      assert.equal(volAttr.status, NTSTATUS.SUCCESS);
      assert.ok((volAttr.attribute.attributes & FS_ATTRIBUTES.READ_ONLY_VOLUME) !== 0);

      // Write rejected
      const writeRes = await bridge.handleOp("s-ro", {
        op: "write",
        deviceId: 11,
        fileId: opened.fileId,
        completionId: 5,
        offset: 0,
        data: new Uint8Array(Buffer.from("mutated")),
      });
      assert.equal(writeRes.status, NTSTATUS.MEDIA_WRITE_PROTECTED);

      // All set_information variants rejected
      for (const req of [
        { informationClass: FILE_INFO_CLASS.RENAME, renameTarget: "\\x.txt", replaceIfExists: true },
        { informationClass: FILE_INFO_CLASS.DISPOSITION, deleteOnClose: true },
        { informationClass: FILE_INFO_CLASS.END_OF_FILE, eofSize: 0 },
        { informationClass: FILE_INFO_CLASS.BASIC, lastWriteTime: unixMsToFiletimeString(Date.now()) },
      ]) {
        const setRes = await bridge.handleOp("s-ro", {
          op: "set_information",
          deviceId: 11,
          fileId: opened.fileId,
          completionId: 6,
          ...req,
        });
        assert.equal(setRes.status, NTSTATUS.MEDIA_WRITE_PROTECTED);
      }

      // Create new / overwrite / supersede / delete-on-close rejected
      for (const createReq of [
        { path: "\\new.txt", createDisposition: CREATE_DISPOSITION.FILE_CREATE, desiredAccess: DESIRED_ACCESS.GENERIC_WRITE },
        { path: "\\new.txt", createDisposition: CREATE_DISPOSITION.FILE_OPEN_IF, desiredAccess: DESIRED_ACCESS.GENERIC_READ },
        { path: "\\readonly.txt", createDisposition: CREATE_DISPOSITION.FILE_OVERWRITE, desiredAccess: DESIRED_ACCESS.GENERIC_WRITE },
        { path: "\\readonly.txt", createDisposition: CREATE_DISPOSITION.FILE_OVERWRITE_IF, desiredAccess: DESIRED_ACCESS.GENERIC_WRITE },
        { path: "\\readonly.txt", createDisposition: CREATE_DISPOSITION.FILE_SUPERSEDE, desiredAccess: DESIRED_ACCESS.GENERIC_WRITE },
        {
          path: "\\readonly.txt",
          createDisposition: CREATE_DISPOSITION.FILE_OPEN,
          desiredAccess: DESIRED_ACCESS.DELETE,
          createOptions: CREATE_OPTIONS.FILE_DELETE_ON_CLOSE,
        },
      ]) {
        const res = await bridge.handleOp("s-ro", {
          op: "create",
          deviceId: 11,
          fileId: 0,
          completionId: 7,
          createOptions: 0,
          ...createReq,
        });
        assert.equal(res.status, NTSTATUS.MEDIA_WRITE_PROTECTED);
      }

      await bridge.handleOp("s-ro", { op: "close", deviceId: 11, fileId: opened.fileId, completionId: 8 });
      assert.equal(fs.readFileSync(path.join(sb.driveRoot, "readonly.txt"), "utf8"), "immutable-data");
    } finally {
      await bridge.cleanupAll();
      sb.cleanup();
    }
  });
});

describe("remoteDesktopRdpdrBridge full IRP operations, handle limits, and IPC", () => {
  it("supports create, read/write, query_directory pagination, metadata, volume info, rename, truncate, deleteOnClose, reset, and unsupported ops", async () => {
    const sb = createTempSandbox();
    const bridge = createRemoteDesktopRdpdrBridge();
    try {
      await bridge.registerDrives("s-rw", [
        { deviceId: 12, name: "Work", path: sb.driveRoot, readOnly: false },
      ]);

      // Create subdirectory
      const mkSub = await bridge.handleOp("s-rw", {
        op: "create",
        deviceId: 12,
        fileId: 0,
        completionId: 1,
        path: "\\docs",
        desiredAccess: DESIRED_ACCESS.GENERIC_ALL,
        createDisposition: CREATE_DISPOSITION.FILE_CREATE,
        createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
      });
      assert.equal(mkSub.status, NTSTATUS.SUCCESS);
      assert.equal(mkSub.information, CREATE_INFORMATION.FILE_CREATED);
      await bridge.handleOp("s-rw", { op: "close", deviceId: 12, fileId: mkSub.fileId, completionId: 2 });

      // Create & write file inside subdirectory
      const mkFile = await bridge.handleOp("s-rw", {
        op: "create",
        deviceId: 12,
        fileId: 0,
        completionId: 3,
        path: "\\docs\\hello.txt",
        desiredAccess: DESIRED_ACCESS.GENERIC_ALL,
        createDisposition: CREATE_DISPOSITION.FILE_CREATE,
        createOptions: CREATE_OPTIONS.FILE_NON_DIRECTORY_FILE,
      });
      assert.equal(mkFile.status, NTSTATUS.SUCCESS);
      assert.ok(mkFile.fileId >= 1);

      const write1 = await bridge.handleOp("s-rw", {
        op: "write",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 4,
        offset: 0,
        data: new Uint8Array(Buffer.from("Hello, RDPDR World!")),
      });
      assert.equal(write1.status, NTSTATUS.SUCCESS);
      assert.equal(write1.bytesWritten, 19);

      const flushRes = await bridge.handleOp("s-rw", {
        op: "flush",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 5,
      });
      assert.equal(flushRes.status, NTSTATUS.SUCCESS);

      const lockRes = await bridge.handleOp("s-rw", {
        op: "lock_control",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 6,
      });
      assert.equal(lockRes.status, NTSTATUS.SUCCESS);

      const devCtl = await bridge.handleOp("s-rw", {
        op: "device_control",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 7,
      });
      assert.equal(devCtl.status, NTSTATUS.NOT_SUPPORTED);

      const notify = await bridge.handleOp("s-rw", {
        op: "notify_change_directory",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 8,
      });
      assert.equal(notify.status, NTSTATUS.NOT_SUPPORTED);

      // Read slice at offset + oversized length clamped safely to MAX_READ_BYTES
      const readSlice = await bridge.handleOp("s-rw", {
        op: "read",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 9,
        offset: 7,
        length: MAX_READ_BYTES + 4096,
      });
      assert.equal(readSlice.status, NTSTATUS.SUCCESS);
      assert.equal(Buffer.from(readSlice.data).toString("utf8"), "RDPDR World!");

      // Query standard & attribute tag info
      const stdInfo = await bridge.handleOp("s-rw", {
        op: "query_information",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 10,
        informationClass: FILE_INFO_CLASS.STANDARD,
      });
      assert.equal(stdInfo.status, NTSTATUS.SUCCESS);
      assert.equal(stdInfo.standard.endOfFile, 19);
      assert.equal(stdInfo.standard.directory, false);
      assert.equal(stdInfo.standard.deletePending, false);

      const attrTag = await bridge.handleOp("s-rw", {
        op: "query_information",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 11,
        informationClass: FILE_INFO_CLASS.ATTRIBUTE_TAG,
      });
      assert.equal(attrTag.status, NTSTATUS.SUCCESS);
      assert.equal(attrTag.attributeTag.reparseTag, 0);

      // Query all volume info classes
      for (const cls of [
        FS_INFO_CLASS.VOLUME,
        FS_INFO_CLASS.SIZE,
        FS_INFO_CLASS.DEVICE,
        FS_INFO_CLASS.ATTRIBUTE,
        FS_INFO_CLASS.FULL_SIZE,
      ]) {
        const vol = await bridge.handleOp("s-rw", {
          op: "query_volume_information",
          deviceId: 12,
          fileId: mkFile.fileId,
          completionId: 12,
          informationClass: cls,
        });
        assert.equal(vol.status, NTSTATUS.SUCCESS);
      }

      // Truncate via END_OF_FILE
      const trunc = await bridge.handleOp("s-rw", {
        op: "set_information",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 13,
        informationClass: FILE_INFO_CLASS.END_OF_FILE,
        eofSize: 5,
      });
      assert.equal(trunc.status, NTSTATUS.SUCCESS);
      assert.equal(fs.readFileSync(path.join(sb.driveRoot, "docs", "hello.txt"), "utf8"), "Hello");

      // Update basic timestamps
      const targetTs = Date.UTC(2025, 0, 2, 3, 4, 5);
      const setBasic = await bridge.handleOp("s-rw", {
        op: "set_information",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 14,
        informationClass: FILE_INFO_CLASS.BASIC,
        lastWriteTime: unixMsToFiletimeString(targetTs),
      });
      assert.equal(setBasic.status, NTSTATUS.SUCCESS);

      // Rename within drive
      const renamed = await bridge.handleOp("s-rw", {
        op: "set_information",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 15,
        informationClass: FILE_INFO_CLASS.RENAME,
        renameTarget: "\\docs\\renamed.txt",
        replaceIfExists: false,
      });
      assert.equal(renamed.status, NTSTATUS.SUCCESS);
      assert.equal(fs.existsSync(path.join(sb.driveRoot, "docs", "hello.txt")), false);
      assert.equal(fs.existsSync(path.join(sb.driveRoot, "docs", "renamed.txt")), true);

      // Mark delete-on-close via DISPOSITION and verify close deletes file
      const markDel = await bridge.handleOp("s-rw", {
        op: "set_information",
        deviceId: 12,
        fileId: mkFile.fileId,
        completionId: 16,
        informationClass: FILE_INFO_CLASS.DISPOSITION,
        deleteOnClose: true,
      });
      assert.equal(markDel.status, NTSTATUS.SUCCESS);
      await bridge.handleOp("s-rw", { op: "close", deviceId: 12, fileId: mkFile.fileId, completionId: 17 });
      assert.equal(fs.existsSync(path.join(sb.driveRoot, "docs", "renamed.txt")), false);

      // Query directory pagination inside subdirectory includes '.' and '..' + matching files
      fs.writeFileSync(path.join(sb.driveRoot, "docs", "alpha.txt"), "a");
      fs.writeFileSync(path.join(sb.driveRoot, "docs", "beta.log"), "b");
      const openDocs = await bridge.handleOp("s-rw", {
        op: "create",
        deviceId: 12,
        fileId: 0,
        completionId: 18,
        path: "\\docs",
        desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
      });
      assert.equal(openDocs.status, NTSTATUS.SUCCESS);

      const txtEntries = [];
      let first = true;
      for (;;) {
        const q = await bridge.handleOp("s-rw", {
          op: "query_directory",
          deviceId: 12,
          fileId: openDocs.fileId,
          completionId: 19,
          initialQuery: first,
          informationClass: FILE_INFO_CLASS.BOTH_DIRECTORY,
          path: "\\docs\\*.txt",
        });
        first = false;
        if (q.status === NTSTATUS.NO_MORE_FILES) break;
        assert.equal(q.status, NTSTATUS.SUCCESS);
        txtEntries.push(q.entry.fileName);
      }
      assert.deepEqual(txtEntries, ["alpha.txt"]);

      // Reset op closes open handles while keeping drives registered
      assert.equal(bridge.getSessionHandleCount("s-rw"), 1);
      const resetRes = await bridge.handleOp("s-rw", {
        op: "reset",
        deviceId: 0,
        fileId: 0,
        completionId: 0,
      });
      assert.equal(resetRes.status, NTSTATUS.SUCCESS);
      assert.equal(bridge.getSessionHandleCount("s-rw"), 0);
      assert.equal(bridge.getSessionDriveCount("s-rw"), 1);
    } finally {
      await bridge.cleanupAll();
      sb.cleanup();
    }
  });

  it("enforces max open handles per session and frees slots on close", async () => {
    const sb = createTempSandbox();
    const bridge = createRemoteDesktopRdpdrBridge({ maxOpenHandles: 3 });
    try {
      await bridge.registerDrives("s-cap", [
        { deviceId: 10, name: "Cap", path: sb.driveRoot, readOnly: false },
      ]);

      const openedIds = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await bridge.handleOp("s-cap", {
          op: "create",
          deviceId: 10,
          fileId: 0,
          completionId: i,
          path: "\\",
          desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
          createDisposition: CREATE_DISPOSITION.FILE_OPEN,
          createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
        });
        assert.equal(res.status, NTSTATUS.SUCCESS);
        openedIds.push(res.fileId);
      }

      const overflow = await bridge.handleOp("s-cap", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 99,
        path: "\\",
        desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
      });
      assert.equal(overflow.status, NTSTATUS.INSUFFICIENT_RESOURCES);

      await bridge.handleOp("s-cap", { op: "close", deviceId: 10, fileId: openedIds[0], completionId: 100 });
      const reopened = await bridge.handleOp("s-cap", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 101,
        path: "\\",
        desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
      });
      assert.equal(reopened.status, NTSTATUS.SUCCESS);
      assert.notEqual(reopened.fileId, openedIds[1]);
      assert.notEqual(reopened.fileId, openedIds[2]);
    } finally {
      await bridge.cleanupAll();
      sb.cleanup();
    }
  });

  it("registers Electron IPC handlers for pick-folder, rdpdr ops, webContents auto-cleanup, and local displays", async () => {
    const sb = createTempSandbox();
    const handlers = new Map();
    const fakeIpcMain = {
      handle: (channel, fn) => handlers.set(channel, fn),
    };
    const fakeElectron = {
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [sb.driveRoot] }),
      },
      BrowserWindow: {
        fromWebContents: () => ({ id: 1 }),
      },
      screen: {
        getPrimaryDisplay: () => ({ id: 100, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 }),
        getAllDisplays: () => [
          { id: 100, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 },
          { id: 200, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        ],
      },
    };

    const { bridge, cleanupAll } = registerRdpdrHandlers(fakeIpcMain, { electronModule: fakeElectron });
    try {
      const sender = new EventEmitter();
      sender.id = 42;
      const fakeEvent = { sender };

      // Pick folder
      const picked = await handlers.get("netcatty:remote-desktop:rdpdr:pick-folder")(fakeEvent);
      assert.equal(picked.ok, true);
      assert.equal(picked.canceled, false);
      assert.equal(picked.path, sb.driveRoot);
      assert.equal(picked.name, "share");

      // Local displays
      const displays = await handlers.get("netcatty:remote-desktop:get-local-displays")(fakeEvent);
      assert.deepEqual(displays, [
        { id: 100, left: 0, top: 0, width: 2560, height: 1440, scaleFactor: 2, isPrimary: true },
        { id: 200, left: 2560, top: 0, width: 1920, height: 1080, scaleFactor: 1, isPrimary: false },
      ]);

      // Register drives + open handle + destroy webContents -> auto cleanup
      const reg = await handlers.get("netcatty:remote-desktop:rdpdr:register-drives")(fakeEvent, {
        sessionId: "ipc-session-1",
        drives: [{ deviceId: 10, name: "HostShare", path: sb.driveRoot, readOnly: false }],
      });
      assert.equal(reg.ok, true);
      const open = await handlers.get("netcatty:remote-desktop:rdpdr:op")(fakeEvent, {
        sessionId: "ipc-session-1",
        request: {
          op: "create",
          deviceId: 10,
          fileId: 0,
          completionId: 1,
          path: "\\",
          desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
          createDisposition: CREATE_DISPOSITION.FILE_OPEN,
          createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
        },
      });
      assert.equal(open.status, NTSTATUS.SUCCESS);
      assert.equal(bridge.getSessionHandleCount("ipc-session-1"), 1);

      sender.emit("destroyed");
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(bridge.getSessionHandleCount("ipc-session-1"), 0);
      assert.equal(bridge.getSessionDriveCount("ipc-session-1"), 0);
    } finally {
      await cleanupAll();
      sb.cleanup();
    }
  });

  it("concurrent cleanupSession during reconnect does not wipe newly registered drives", async () => {
    const sb = createTempSandbox();
    fs.writeFileSync(path.join(sb.driveRoot, "hello.txt"), "hello-reconnect");
    const realFsPromises = fs.promises;
    let releaseClose;
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    let closeStarted;
    const closeStartedPromise = new Promise((resolve) => {
      closeStarted = resolve;
    });

    const wrappedFsPromises = {
      ...realFsPromises,
      open: async (...args) => {
        const fh = await realFsPromises.open(...args);
        const origClose = fh.close.bind(fh);
        fh.close = async () => {
          closeStarted();
          await closeGate;
          return origClose();
        };
        return fh;
      },
    };

    const bridge = createRemoteDesktopRdpdrBridge({
      fsImpl: { ...fs, promises: wrappedFsPromises },
    });
    try {
      await bridge.registerDrives("reconnect-sess", [
        { deviceId: 10, name: "ShareA", path: sb.driveRoot, readOnly: false },
      ]);
      const opened = await bridge.handleOp("reconnect-sess", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 1,
        path: "\\hello.txt",
        desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: 0,
      });
      assert.equal(opened.status, NTSTATUS.SUCCESS);
      assert.equal(bridge.getSessionHandleCount("reconnect-sess"), 1);

      // Start cleanup (pauses inside fh.close), then immediately register drives for reconnect
      const cleanupPromise = bridge.cleanupSession("reconnect-sess");
      await closeStartedPromise;

      const regNext = await bridge.registerDrives("reconnect-sess", [
        { deviceId: 10, name: "ShareA", path: sb.driveRoot, readOnly: false },
      ]);
      assert.equal(regNext.ok, true);
      assert.equal(regNext.registered.length, 1);

      // Now let the old cleanup finish closing its detached handle
      releaseClose();
      await cleanupPromise;

      // Reconnected session drives must still be intact and usable
      assert.equal(bridge.getSessionDriveCount("reconnect-sess"), 1);
      const reopened = await bridge.handleOp("reconnect-sess", {
        op: "create",
        deviceId: 10,
        fileId: 0,
        completionId: 2,
        path: "\\hello.txt",
        desiredAccess: DESIRED_ACCESS.FILE_READ_DATA,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: 0,
      });
      assert.equal(reopened.status, NTSTATUS.SUCCESS);
    } finally {
      releaseClose?.();
      await bridge.cleanupAll();
      sb.cleanup();
    }
  });

  it("renaming a directory updates open child handle paths and concurrent cleanup closes late-opened handles", async () => {
    const sb = createTempSandbox();
    fs.mkdirSync(path.join(sb.driveRoot, "dirA"));
    fs.writeFileSync(path.join(sb.driveRoot, "dirA", "child.txt"), "child-content");

    const bridge = createRemoteDesktopRdpdrBridge();
    try {
      await bridge.registerDrives("rename-sess", [
        { deviceId: 20, name: "ShareR", path: sb.driveRoot, readOnly: false },
      ]);

      const openDir = await bridge.handleOp("rename-sess", {
        op: "create",
        deviceId: 20,
        fileId: 0,
        completionId: 1,
        path: "\\dirA",
        desiredAccess: DESIRED_ACCESS.GENERIC_ALL,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: CREATE_OPTIONS.FILE_DIRECTORY_FILE,
      });
      assert.equal(openDir.status, NTSTATUS.SUCCESS);

      const openChild = await bridge.handleOp("rename-sess", {
        op: "create",
        deviceId: 20,
        fileId: 0,
        completionId: 2,
        path: "\\dirA\\child.txt",
        desiredAccess: DESIRED_ACCESS.GENERIC_ALL,
        createDisposition: CREATE_DISPOSITION.FILE_OPEN,
        createOptions: CREATE_OPTIONS.FILE_NON_DIRECTORY_FILE,
      });
      assert.equal(openChild.status, NTSTATUS.SUCCESS);

      const renameDir = await bridge.handleOp("rename-sess", {
        op: "set_information",
        deviceId: 20,
        fileId: openDir.fileId,
        completionId: 3,
        informationClass: FILE_INFO_CLASS.RENAME,
        renameTarget: "\\dirB",
      });
      assert.equal(renameDir.status, NTSTATUS.SUCCESS);

      // Querying metadata on already-open child handle must still succeed at new path
      const childInfo = await bridge.handleOp("rename-sess", {
        op: "query_information",
        deviceId: 20,
        fileId: openChild.fileId,
        completionId: 4,
        informationClass: FILE_INFO_CLASS.STANDARD,
      });
      assert.equal(childInfo.status, NTSTATUS.SUCCESS);
      assert.equal(childInfo.standard.endOfFile, 13);
    } finally {
      await bridge.cleanupAll();
      sb.cleanup();
    }
  });
});
