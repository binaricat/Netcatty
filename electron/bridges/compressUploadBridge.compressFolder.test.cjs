"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const localTarCommand = process.platform === "win32"
  ? path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe")
  : "tar";

// The bridge destructures spawn and getTempFilePath at load time, so record
// tar calls and redirect temp archives before requiring it.
let tempDir = null;
const spawnCalls = [];
const realSpawn = childProcess.spawn;
const originalLoad = Module._load;
childProcess.spawn = (command, args, options) => {
  spawnCalls.push({ command, args, options });
  return realSpawn(command, args, options);
};
Module._load = function load(request, parent, isMain) {
  if (request === "./tempDirBridge.cjs") {
    return { getTempFilePath: (fileName) => path.join(tempDir, `1_1_${fileName}`) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const compressUploadBridge = require("./compressUploadBridge.cjs");
childProcess.spawn = realSpawn;
Module._load = originalLoad;

function createFolder(t, parentName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-folder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folderPath = path.join(root, parentName, "folder");
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  return { root, folderPath };
}

async function compressAndList(folderPath) {
  let archiveEntries = null;
  const handlers = new Map();
  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([["sftp-folder", {
      client: {
        writable: true,
        exec(command, callback) {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          stream.close = () => {};
          stream.end = () => {};
          stream.destroy = () => {};
          callback(null, stream);
          process.nextTick(() => {
            if (command === "tar --version") stream.emit("data", Buffer.from("tar"));
            stream.emit("close", 0);
          });
        },
      },
      __netcattyEndpointKey: "endpoint:folder",
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent() {},
      async startInternalTransfer(_event, payload) {
        // Read the archive through stdin so its path never reaches tar argv.
        archiveEntries = childProcess.execFileSync("tar", ["-tzf", "-"], {
          input: fs.readFileSync(payload.sourcePath),
          encoding: "utf8",
        })
          .split(/\r?\n/)
          .filter(Boolean)
          .map((entry) => entry.replace(/\/$/, ""))
          .sort();
        return { success: true };
      },
      async cancelTransfer() { return { success: true }; },
    },
  });
  compressUploadBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });

  spawnCalls.length = 0;
  const result = await handlers.get("netcatty:compress:start")({ sender: { id: 1, send() {} } }, {
    compressionId: "compress-folder",
    folderPath,
    targetPath: "/srv",
    sftpId: "sftp-folder",
    folderName: "folder",
    totalBytes: 7,
  });
  const tarCall = spawnCalls.find((call) => call.command === localTarCommand && call.args.includes("-czf"));
  return { result, archiveEntries, tarCall };
}

test("local tar gets its paths through cwd and stdout instead of argv", async (t) => {
  // Non-ASCII parent and temp directories, as with a Chinese Windows user name.
  const { root, folderPath } = createFolder(t, "下载目录");
  tempDir = path.dirname(folderPath);

  const { result, archiveEntries, tarCall } = await compressAndList(folderPath);

  assert.equal(result.success, true);
  assert.equal(spawnCalls.find((call) => call.args.includes("--version"))?.command, localTarCommand);
  assert.ok(tarCall, "local tar compression must be spawned");
  assert.equal(tarCall.options.cwd, path.dirname(folderPath));
  assert.equal(tarCall.args.includes("-C"), false, "parent directory must not be passed through argv");
  assert.deepEqual(tarCall.args.slice(0, 2), ["-czf", "-"]);
  assert.equal(typeof tarCall.options.stdio[1], "number", "the archive file must be tar's stdout");
  assert.equal(tarCall.args.some((arg) => arg.includes(root)), false, "no local path may reach tar argv");
  assert.equal(tarCall.args.at(-1), "folder");
  assert.deepEqual(archiveEntries, ["folder", "folder/file.txt"]);
});

test("an archive written inside the source folder is excluded from itself", async (t) => {
  const { folderPath } = createFolder(t, "parent");
  tempDir = path.join(folderPath, "tmp");
  fs.mkdirSync(tempDir);

  const { result, archiveEntries, tarCall } = await compressAndList(folderPath);

  assert.equal(result.success, true);
  assert.ok(tarCall.args.includes("--exclude=folder/tmp/1_1_folder.tar.gz"));
  assert.deepEqual(archiveEntries, ["folder", "folder/file.txt", "folder/tmp"]);
});
