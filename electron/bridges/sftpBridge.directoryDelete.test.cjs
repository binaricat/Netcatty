const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const sftpBridge = require("./sftpBridge.cjs");

function createNestedDirectoryChannel() {
  const entries = new Map([
    ["/home/user/parent", "directory"],
    ["/home/user/parent/child", "directory"],
    ["/home/user/parent/child/file.txt", "file"],
  ]);
  const calls = { exec: [], rmdir: [], unlink: [] };
  const toPath = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const channel = {
    mkdir(_targetPath, callback) {
      callback(null);
    },
    stat(targetPath, callback) {
      const value = toPath(targetPath);
      const type = entries.get(value);
      if (!type) {
        const error = new Error(`No such file: ${value}`);
        error.code = 2;
        callback(error);
        return;
      }
      callback(null, {
        isDirectory: () => type === "directory" || type === "directory-symlink",
        isSymbolicLink: () => false,
      });
    },
    lstat(targetPath, callback) {
      const value = toPath(targetPath);
      const type = entries.get(value);
      if (!type) {
        const error = new Error(`No such file: ${value}`);
        error.code = 2;
        callback(error);
        return;
      }
      callback(null, {
        isDirectory: () => type === "directory",
        isSymbolicLink: () => type === "directory-symlink",
      });
    },
    readdir(targetPath, callback) {
      const value = toPath(targetPath);
      const prefix = `${value.replace(/\/$/, "")}/`;
      const names = new Set();
      for (const entryPath of entries.keys()) {
        if (!entryPath.startsWith(prefix)) continue;
        const rest = entryPath.slice(prefix.length);
        if (rest && !rest.includes("/")) names.add(rest);
      }
      callback(null, [...names].map((filename) => ({ filename })));
    },
    unlink(targetPath, callback) {
      const value = toPath(targetPath);
      calls.unlink.push(value);
      entries.delete(value);
      callback(null);
    },
    rmdir(targetPath, callback) {
      const value = toPath(targetPath);
      calls.rmdir.push(value);
      entries.delete(value);
      callback(null);
    },
    realpath(targetPath, callback) {
      callback(null, toPath(targetPath));
    },
  };
  return { calls, channel, entries };
}

test("directory delete does not trust an unrelated shell success", async () => {
  const tree = createNestedDirectoryChannel();
  const sshClient = {
    exec(command, callback) {
      tree.calls.exec.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      callback(null, stream);
      // `rm -rf` can return zero when the shell and SFTP channel resolve the
      // same-looking path in different roots. It did not touch our SFTP tree.
      queueMicrotask(() => stream.emit("close", 0));
    },
  };
  const client = { client: sshClient, sftp: tree.channel };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["delete-test", client]]),
  });

  await sftpBridge.deleteSftp(null, {
    sftpId: "delete-test",
    path: "/home/user/parent",
    encoding: "utf-8",
  });

  assert.equal(tree.entries.has("/home/user/parent"), false);
  assert.deepEqual(tree.calls.unlink, ["/home/user/parent/child/file.txt"]);
  assert.deepEqual(tree.calls.rmdir, ["/home/user/parent/child", "/home/user/parent"]);
  assert.deepEqual(tree.calls.exec, []);
});

test("directory delete preserves leading-dot directory names", async () => {
  const tree = createNestedDirectoryChannel();
  tree.entries.clear();
  tree.entries.set(".cache", "directory");
  tree.entries.set(".cache/item.txt", "file");
  tree.entries.set("ache", "directory");
  tree.entries.set("..staging", "directory");
  tree.entries.set("..staging/item.txt", "file");
  tree.entries.set("../taging", "directory");

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["dot-delete-test", { sftp: tree.channel }]]),
  });

  await sftpBridge.deleteSftp(null, {
    sftpId: "dot-delete-test",
    path: ".cache",
    encoding: "utf-8",
  });
  await sftpBridge.deleteSftp(null, {
    sftpId: "dot-delete-test",
    path: "..staging",
    encoding: "utf-8",
  });

  assert.equal(tree.entries.has(".cache"), false);
  assert.equal(tree.entries.has("..staging"), false);
  assert.equal(tree.entries.has("ache"), true);
  assert.equal(tree.entries.has("../taging"), true);
});

test("directory delete unlinks a directory symlink without touching its target", async () => {
  const tree = createNestedDirectoryChannel();
  tree.entries.clear();
  tree.entries.set("/home/user/link", "directory-symlink");
  tree.entries.set("/home/user/target", "directory");
  tree.entries.set("/home/user/target/item.txt", "file");

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["symlink-delete-test", { sftp: tree.channel }]]),
  });

  await sftpBridge.deleteSftp(null, {
    sftpId: "symlink-delete-test",
    path: "/home/user/link",
    encoding: "utf-8",
  });

  assert.equal(tree.entries.has("/home/user/link"), false);
  assert.equal(tree.entries.has("/home/user/target"), true);
  assert.equal(tree.entries.has("/home/user/target/item.txt"), true);
  assert.deepEqual(tree.calls.unlink, ["/home/user/link"]);
  assert.deepEqual(tree.calls.rmdir, []);
});
