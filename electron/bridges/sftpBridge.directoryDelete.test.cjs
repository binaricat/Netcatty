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


function createIdleShellSession(onCommand) {
  const writes = [];
  const stream = new EventEmitter();
  stream.write = (data) => {
    const command = String(data);
    writes.push(command);
    const marker = command.match(/NETCATTY_RM_[a-f0-9]+/)?.[0];
    const code = onCommand(command);
    queueMicrotask(() => {
      if (marker && typeof code === "number") {
        stream.emit("data", Buffer.from(`\n${marker}:${code}\n[root@host ~]# `));
      }
    });
    return true;
  };
  const session = {
    stream,
    hostname: "10.0.9.115",
    username: "root",
    connRef: { endpointKey: "endpoint-a" },
    _promptTrackTail: "[root@host ~]# ",
  };
  return { session, writes };
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
  // Prefer a live SFTP channel for requireSftpChannel / lstat verify.
  const client = {
    client: sshClient,
    sftp: tree.channel,
    async sftp(cb) {
      if (typeof cb === "function") cb(null, tree.channel);
      return tree.channel;
    },
  };
  // ssh2-sftp-client style: some paths use client.sftp as channel object.
  Object.assign(client, { sftp: tree.channel });
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
  // Fast path may attempt shell rm -rf, but must fall back to protocol walk
  // when SFTP still sees the path after a fake shell success.
  assert.ok(
    tree.calls.exec.length === 0
    || tree.calls.exec.some((command) => String(command).includes("rm -rf")),
  );
  assert.deepEqual(tree.calls.unlink, ["/home/user/parent/child/file.txt"]);
  assert.deepEqual(tree.calls.rmdir, ["/home/user/parent/child", "/home/user/parent"]);
});

test("directory delete uses verified shell rm -rf when SFTP path is gone", async () => {
  const tree = createNestedDirectoryChannel();
  const sshClient = {
    exec(command, callback) {
      tree.calls.exec.push(command);
      // Actually remove the SFTP-visible tree so verify succeeds.
      if (String(command).includes("rm -rf")) {
        for (const key of [...tree.entries.keys()]) {
          if (key === "/home/user/parent" || key.startsWith("/home/user/parent/")) {
            tree.entries.delete(key);
          }
        }
      }
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      callback(null, stream);
      queueMicrotask(() => stream.emit("close", 0));
    },
  };
  const client = { client: sshClient, sftp: tree.channel };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["delete-fast-test", client]]),
  });

  await sftpBridge.deleteSftp(null, {
    sftpId: "delete-fast-test",
    path: "/home/user/parent",
    encoding: "utf-8",
  });

  assert.equal(tree.entries.has("/home/user/parent"), false);
  assert.ok(tree.calls.exec.some((command) => String(command).includes("rm -rf")));
  // Protocol walk should not be needed when shell verify succeeds.
  assert.deepEqual(tree.calls.unlink, []);
  assert.deepEqual(tree.calls.rmdir, []);
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

test("single-channel directory delete runs rm on the SSH channel and keeps SFTP open", async () => {
  const tree = createNestedDirectoryChannel();
  let channelEnded = 0;
  tree.channel.end = () => { channelEnded += 1; };
  const sshClient = {
    exec() {
      throw new Error("exec on the file connection");
    },
  };
  const shell = createIdleShellSession((command) => {
    assert.match(command, /rm -rf -- '\/home\/user\/parent'/);
    assert.equal(channelEnded, 0);
    for (const key of [...tree.entries.keys()]) {
      if (key === "/home/user/parent" || key.startsWith("/home/user/parent/")) {
        tree.entries.delete(key);
      }
    }
    return 0;
  });
  const client = {
    __netcattySingleChannelSsh: true,
    __netcattyEndpointKey: "endpoint-a",
    client: sshClient,
    sftp: tree.channel,
  };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map([["term-1", shell.session]]),
    sftpClients: new Map([["single-channel-delete", client]]),
  });

  await sftpBridge.deleteSftp(null, {
    sftpId: "single-channel-delete",
    path: "/home/user/parent",
    encoding: "utf-8",
  });

  assert.equal(tree.entries.has("/home/user/parent"), false);
  assert.equal(shell.writes.length, 1);
  assert.equal(channelEnded, 0);
  assert.deepEqual(tree.calls.unlink, []);
  assert.deepEqual(tree.calls.rmdir, []);
});

test("single-channel directory delete does not close SFTP when the SSH command fails", async () => {
  const tree = createNestedDirectoryChannel();
  let channelEnded = 0;
  tree.channel.end = () => { channelEnded += 1; };
  const shell = createIdleShellSession(() => 1);
  sftpBridge.init({
    electronModule: {},
    sessions: new Map([["term-1", shell.session]]),
    sftpClients: new Map([["single-channel-fail", {
      __netcattySingleChannelSsh: true,
      __netcattyEndpointKey: "endpoint-a",
      client: { exec() { throw new Error("exec on the file connection"); } },
      sftp: tree.channel,
    }]]),
  });

  await assert.rejects(
    () => sftpBridge.deleteSftp(null, {
      sftpId: "single-channel-fail",
      path: "/home/user/parent",
      encoding: "utf-8",
    }),
    /Remote command failed \(code 1\)/,
  );
  assert.equal(tree.entries.has("/home/user/parent"), true);
  assert.equal(channelEnded, 0);
  assert.deepEqual(tree.calls.unlink, []);
  assert.deepEqual(tree.calls.rmdir, []);
});

test("single-channel directory delete asks for an SSH terminal instead of closing SFTP", async () => {
  const tree = createNestedDirectoryChannel();
  let channelEnded = 0;
  tree.channel.end = () => { channelEnded += 1; };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["single-channel-no-shell", {
      __netcattySingleChannelSsh: true,
      __netcattyEndpointKey: "endpoint-a",
      client: { exec() { throw new Error("exec on the file connection"); } },
      sftp: tree.channel,
    }]]),
  });

  await assert.rejects(
    () => sftpBridge.deleteSftp(null, {
      sftpId: "single-channel-no-shell",
      path: "/home/user/parent",
      encoding: "utf-8",
    }),
    /SSH 终端/,
  );
  assert.equal(channelEnded, 0);
  assert.equal(tree.entries.has("/home/user/parent"), true);
});

test("single-channel directory delete finds the SSH terminal by host when endpoint keys differ", async () => {
  const tree = createNestedDirectoryChannel();
  let channelEnded = 0;
  tree.channel.end = () => { channelEnded += 1; };
  const shell = createIdleShellSession(() => {
    for (const key of [...tree.entries.keys()]) {
      if (key === "/home/user/parent" || key.startsWith("/home/user/parent/")) tree.entries.delete(key);
    }
    return 0;
  });
  shell.session.connRef = { endpointKey: "terminal-key", endpoint: { port: 22, hostId: "host-1" } };
  shell.session.hostname = "10.0.9.115";
  shell.session.username = "root";
  shell.session._reuseEndpoint = { hostname: "10.0.9.115", port: 22, username: "root", hostId: "host-1" };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map([["term-1", shell.session]]),
    sftpClients: new Map([["single-channel-host", {
      __netcattySingleChannelSsh: true,
      __netcattyEndpointKey: "host-1|10.0.9.115|22|root|ssh|nosudo|-|-|-|keepalive:0:0",
      client: { exec() { throw new Error("exec on the file connection"); } },
      sftp: tree.channel,
    }]]),
  });

  await sftpBridge.deleteSftp(null, {
    sftpId: "single-channel-host",
    path: "/home/user/parent",
    encoding: "utf-8",
  });

  assert.equal(tree.entries.has("/home/user/parent"), false);
  assert.equal(channelEnded, 0);
});
