const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable, PassThrough } = require("node:stream");
const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");

const missing = () => Object.assign(new Error("ENOENT"), { code: 2 });

async function openSessionClient(t, { sourceIsLink = false, targetExists = false } = {}) {
  const commands = [];
  const channel = new EventEmitter();
  channel.readdir = (_path, callback) => callback(null, []);
  channel.mkdir = (_path, callback) => callback(null);
  channel.unlink = (_path, callback) => callback(null);
  channel.stat = (remotePath, callback) => {
    if (String(remotePath) === "/target/file" && !targetExists) return callback(missing());
    callback(null, { size: 66, mode: 0o100640, mtime: 1 });
  };
  channel.lstat = (remotePath, callback) => {
    if (String(remotePath) === "/target" && !targetExists) return callback(missing());
    callback(null, { size: 66, mode: sourceIsLink ? 0o120777 : 0o100640, mtime: 1 });
  };
  channel.createReadStream = () => Readable.from([Buffer.alloc(66)]);
  const connection = {
    sftp(callback) { callback(null, channel); },
    exec(command, callback) {
      commands.push(command);
      const stream = new PassThrough();
      stream.stderr = new PassThrough();
      callback(null, stream);
      setImmediate(() => stream.emit("close", 0));
    },
  };
  const clients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["copy-session", { conn: connection }]]),
    sftpClients: clients,
  });
  transferBridge.init({ sftpClients: clients });
  const { sftpId } = await sftpBridge.openSftpForSession(null, {
    sessionId: "copy-session", fileProtocol: "sftp",
  });
  t.after(() => sftpBridge.closeSftp(null, { sftpId }));
  return { client: clients.get(sftpId), channel, commands, sftpId };
}

test("same-host file copy executes cp using the actual session-backed client (#4207)", async (t) => {
  const { commands, sftpId } = await openSessionClient(t);
  const result = await transferBridge.startTransfer({ sender: { send() {} } }, {
    transferId: "session-backed-file-copy",
    sourcePath: "/source/file", targetPath: "/target/file",
    sourceType: "sftp", targetType: "sftp",
    sourceSftpId: sftpId, targetSftpId: sftpId,
    sourceEncoding: "utf-8", targetEncoding: "utf-8",
    totalBytes: 66, sameHost: true, resumable: false,
  });
  assert.deepEqual(commands, ["cp -a '/source/file' '/target/file'"]);
  assert.equal(result.error, undefined);
});

for (const sourceIsLink of [false, true]) {
  test(`session-backed LSTAT preserves link classification (${sourceIsLink})`, async (t) => {
    const { client } = await openSessionClient(t, { sourceIsLink });
    assert.equal((await client.lstat("/source/file")).isSymbolicLink, sourceIsLink);
    assert.equal((await client.stat("/source/file")).isSymbolicLink, false);
  });
}

for (const unsupported of ["missing-method", "server-error"]) {
  test(`session-backed LSTAT never follows STAT on ${unsupported}`, async (t) => {
    const { client, channel } = await openSessionClient(t);
    let statCalls = 0;
    channel.stat = () => { statCalls++; throw new Error("must not follow symlinks"); };
    if (unsupported === "missing-method") delete channel.lstat;
    else channel.lstat = (_path, callback) => callback(Object.assign(new Error("unsupported"), { code: 8 }));
    await assert.rejects(() => client.lstat("/source/file"), error =>
      error.code === (unsupported === "missing-method" ? "ENOTSUP" : 8));
    assert.equal(statCalls, 0);
  });
}

for (const targetExists of [false, true]) {
  test(`session-backed directory cp preserves the destination merge guard (${targetExists})`, async (t) => {
    const { commands, sftpId } = await openSessionClient(t, { targetExists });
    const result = await transferBridge.sameHostCopyDirectory({ sender: { send() {} } }, {
      transferId: `session-backed-directory-copy-${targetExists}`,
      sftpId, sourcePath: "/source", targetPath: "/target", encoding: "utf-8",
    });
    assert.equal(result.success, !targetExists);
    assert.deepEqual(commands, targetExists ? [] : ["cp -ra '/source/.' '/target/'"]);
  });
}
