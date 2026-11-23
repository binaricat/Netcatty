"use strict";

// --- merged from scpProtocol.test.cjs ---
{
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFileControlLine,
  buildDirectoryControlLine,
  buildEndDirectoryLine,
  buildAck,
  parseControlLine,
  consumeAck,
  createSourceStreamParser,
  sanitizeScpBasename,
  ScpProtocolError,
  SCP_OK,
  SCP_ERROR,
  SCP_FATAL,
} = require("./scpProtocol.cjs");
const {
  shellQuote,
  assertSafeRemotePath,
  buildScpSinkCommand,
  buildScpSourceCommand,
  buildListCommand,
  buildMkdirCommand,
  buildDeleteCommand,
  buildUnlinkCommand,
  buildRenameCommand,
  buildChmodCommand,
  parseListRecords,
  parseLsLaOutput,
  ownerFromSftpLongname,
  resolveListingOwner,
  normalizeFileProtocol,
} = require("./scpShell.cjs");

describe("scpProtocol control lines", () => {
  it("builds a file control line with mode size and basename", () => {
    const line = buildFileControlLine({ mode: 0o644, size: 11, name: "hello.txt" });
    assert.equal(line.toString("utf8"), "C0644 11 hello.txt\n");
  });

  it("builds directory and end markers", () => {
    assert.equal(buildDirectoryControlLine({ mode: 0o755, name: "dir" }).toString(), "D0755 0 dir\n");
    assert.equal(buildEndDirectoryLine().toString(), "E\n");
  });

  it("parses file and directory control lines including spaces in names", () => {
    const file = parseControlLine("C0644 3 my file.txt");
    assert.deepEqual(file, { kind: "file", mode: 0o644, size: 3, name: "my file.txt" });
    const dir = parseControlLine("D0755 0 nested");
    assert.equal(dir.kind, "directory");
    assert.equal(dir.name, "nested");
    assert.equal(parseControlLine("E").kind, "end");
  });

  it("rejects path separators in basenames", () => {
    assert.throws(() => sanitizeScpBasename("../x"), ScpProtocolError);
    assert.throws(() => buildFileControlLine({ size: 1, name: "a/b" }), ScpProtocolError);
    assert.throws(() => parseControlLine("C0644 1 a/b"), ScpProtocolError);
    // Backslash is valid on POSIX; do not reject.
    assert.equal(sanitizeScpBasename("a\\b"), "a\\b");
  });

  it("consumeAck handles ok error and fatal", () => {
    assert.deepEqual(consumeAck(Buffer.from([SCP_OK])), { status: "ok", consumed: 1 });
    const err = consumeAck(Buffer.from([SCP_ERROR, ...Buffer.from("nope\n")]));
    assert.equal(err.status, "error");
    assert.equal(err.message, "nope");
    const fatal = consumeAck(Buffer.from([SCP_FATAL, ...Buffer.from("dead\n")]));
    assert.equal(fatal.status, "fatal");
    assert.equal(consumeAck(Buffer.alloc(0)).status, "incomplete");
  });

  it("buildAck is a single NUL", () => {
    assert.deepEqual(buildAck(), Buffer.from([0]));
  });
});

describe("scpProtocol source stream parser", () => {
  it("parses handshake file metadata data and completion", () => {
    const parser = createSourceStreamParser();
    const body = Buffer.from("hi\n");
    const stream = Buffer.concat([
      Buffer.from("C0644 3 hi.txt\n"),
      body,
      Buffer.from([0x00]),
    ]);
    const events = parser.feed(stream);
    assert.equal(events[0].type, "file-start");
    assert.equal(events[0].name, "hi.txt");
    assert.equal(events[0].size, 3);
    assert.equal(events[1].type, "file-data");
    assert.deepEqual(events[1].data, body);
    assert.equal(events[2].type, "file-end");
    parser.finish();
  });

  it("handles chunked feeds and recursive directory markers", () => {
    const parser = createSourceStreamParser();
    const part1 = Buffer.from("D0755 0 d\nC0644 4 ");
    const part2 = Buffer.from("a.txt\nabcd\0E\n");
    const e1 = parser.feed(part1);
    assert.equal(e1[0].type, "directory");
    assert.equal(e1[0].name, "d");
    const e2 = parser.feed(part2);
    assert.equal(e2.find((e) => e.type === "file-start")?.name, "a.txt");
    assert.ok(e2.some((e) => e.type === "file-data"));
    assert.ok(e2.some((e) => e.type === "file-end"));
    assert.ok(e2.some((e) => e.type === "end-directory"));
    parser.finish();
  });
});

describe("scpShell quoting and commands", () => {
  it("quotes paths with single quotes safely", () => {
    assert.equal(shellQuote("simple"), "'simple'");
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
    assert.throws(() => shellQuote("a\0b"), /NUL/);
    assert.throws(() => assertSafeRemotePath("a\nb"), /newline/i);
  });

  it("builds scp -t/-f commands with -- and quoted paths", () => {
    assert.equal(buildScpSinkCommand("/tmp/out"), "scp -t -- '/tmp/out'");
    assert.equal(buildScpSourceCommand("/var/a b"), "scp -f -- '/var/a b'");
    assert.match(buildListCommand("/home/user"), /cd '\/home\/user'/);
    // Must not emit invalid `do;` which breaks POSIX sh for-loops.
    assert.doesNotMatch(buildListCommand("/home/user"), /do;/);
    assert.match(buildListCommand("/home/user"), /do\n/);
    assert.match(buildMkdirCommand("/x/y"), /mkdir -p -- '\/x\/y'/);
    assert.match(buildDeleteCommand("/x", { recursive: true }), /rm -rf -- '\/x'/);
    assert.equal(buildUnlinkCommand("/x"), "rm -f -- '/x'");
    assert.match(buildRenameCommand("/a", "/b"), /mv -- '\/a' '\/b'/);
    assert.match(buildChmodCommand("/a", "755"), /chmod 755 -- '\/a'/);
  });

  it("lsModeToNumber preserves setuid/setgid/sticky bits", () => {
    const { lsModeToNumber } = require("./scpShell.cjs");
    // -rwsr-sr-t : setuid+setgid+sticky with execute (lowercase s/t)
    assert.equal(lsModeToNumber("-rwsr-sr-t"), 0o7755);
    // -rwSrwSrwT : special bits without execute (uppercase S/T)
    assert.equal(lsModeToNumber("-rwSrwSrwT"), 0o7666);
  });

  it("rejects unsafe remote paths for shell ops", () => {
    assert.throws(() => buildScpSourceCommand("x\0y"));
    assert.throws(() => buildDeleteCommand(""));
  });

  it("parses list records with base64 names", () => {
    const name = "你好 world.txt";
    const b64 = Buffer.from(name, "utf8").toString("base64");
    const stdout = `f|-rw-r--r--|12|1700000000|${b64}\nd|drwxr-xr-x|0|1700000001|${Buffer.from("sub").toString("base64")}\n`;
    const rows = parseListRecords(stdout);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, name);
    assert.equal(rows[0].type, "file");
    assert.equal(rows[0].size, 12);
    assert.equal(rows[1].type, "directory");
    assert.equal(rows[1].name, "sub");
  });

  it("parses list records with gb18030 basenames", () => {
    const iconv = require("iconv-lite");
    const name = "测试.txt";
    const b64 = iconv.encode(name, "gb18030").toString("base64");
    const rows = parseListRecords(`f|-rw-r--r--|1|1700000000|${b64}\n`, "gb18030");
    assert.equal(rows[0]?.name, name);
  });

  it("parses optional owner from list records and ls -la fallback", () => {
    const b64 = Buffer.from("notes.txt", "utf8").toString("base64");
    const rows = parseListRecords(`f|-rw-r--r--|12|1700000000|${b64}|www-data\n`);
    assert.equal(rows[0]?.owner, "www-data");

    const legacy = parseListRecords(`f|-rw-r--r--|12|1700000000|${b64}\n`);
    assert.equal(legacy[0]?.owner, undefined);

    const lsRows = parseLsLaOutput(
      "total 4\n-rw-r--r--  1 root  wheel  12 Jan  1 00:00 notes.txt\n",
    );
    assert.equal(lsRows[0]?.name, "notes.txt");
    assert.equal(lsRows[0]?.owner, "root");

    const aclRows = parseLsLaOutput(
      "-rw-r--r--+ 1 alice staff 12 Jan  1 00:00 notes.txt\n",
    );
    assert.equal(aclRows[0]?.owner, "alice");
  });

  it("resolves listing owner from longname, then uid", () => {
    assert.equal(
      ownerFromSftpLongname("-rwxr-xr-x  1 alice  staff  4096 Jan  1 00:00 bin"),
      "alice",
    );
    assert.equal(
      resolveListingOwner({ longname: "drwxr-xr-x  2 www-data www-data 4096 Jan 1 00:00 html" }),
      "www-data",
    );
    assert.equal(resolveListingOwner({ uid: 1000 }), "1000");
    assert.equal(resolveListingOwner({ owner: "UNKNOWN", uid: 0 }), "0");
    assert.equal(
      ownerFromSftpLongname("-rw-r--r--+  1 alice  staff  12 Jan  1 00:00 notes.txt"),
      "alice",
    );
    assert.equal(
      ownerFromSftpLongname("-rw-r--r--@  1 alice  staff  12 Jan  1 00:00 notes.txt"),
      "alice",
    );
    assert.equal(
      ownerFromSftpLongname("-rw-r--r--.  1 alice  staff  12 Jan  1 00:00 notes.txt"),
      "alice",
    );
  });

  it("list command includes owner in the record", () => {
    assert.match(buildListCommand("/tmp"), /awk '\{print \$3\}'/);
    assert.match(buildListCommand("/tmp"), /%s\\|%s\\|%s\\|%s\\|%s\\|%s/);
  });

  it("list command keeps broken symlinks", () => {
    assert.match(buildListCommand("/tmp"), /-L "\$f"/);
    assert.match(buildListCommand("/tmp"), /-e "\$f"/);
  });

  it("normalizes file protocol preference", () => {
    assert.equal(normalizeFileProtocol(undefined), "auto");
    assert.equal(normalizeFileProtocol("SFTP"), "sftp");
    assert.equal(normalizeFileProtocol("scp"), "scp");
    assert.equal(normalizeFileProtocol("other"), "auto");
  });
});
}

// --- merged from scpSessionOps.test.cjs ---
{
/**
 * Integration-style tests: SCP-mode clients registered in sftpClients are
 * reachable through the same list/mkdir/write entry points the UI and AI tools use.
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createScpBackend, isScpModeClient } = require("./scpBackend.cjs");
const { createFileOpsApi } = require("./fileOps.cjs");
const { SCP_OK, buildFileControlLine } = require("./scpProtocol.cjs");

function createMockStream() {
  const ee = new EventEmitter();
  ee.writable = true;
  ee.readable = true;
  ee.stderr = new EventEmitter();
  ee.write = (buf, cb) => {
    ee.emit("_write", Buffer.from(buf));
    if (typeof cb === "function") cb();
    return true;
  };
  ee.end = (cb) => { if (typeof cb === "function") cb(); };
  ee.close = () => ee.emit("close");
  ee.destroy = () => ee.emit("close");
  ee.pushFromRemote = (buf) => ee.emit("data", Buffer.from(buf));
  return ee;
}

describe("SCP-mode session ops via fileOps entry points (AI/UI shared path)", () => {
  let sftpClients;
  let api;
  let commands;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-session-"));
    sftpClients = new Map();
    commands = [];

    const backend = createScpBackend({
      exec: async (command) => {
        commands.push(command);
        if (command.includes("for f in") || command.includes("cd ")) {
          const name = Buffer.from("agent.txt").toString("base64");
          return {
            stdout: `f|-rw-r--r--|4|1700000000|${name}\n`,
            stderr: "",
            code: 0,
          };
        }
        if (command.includes("mkdir")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("rm ") || command.includes("rmdir")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("mv ")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("$HOME") || command.startsWith("printf")) {
          return { stdout: "/home/agent\n", stderr: "", code: 0 };
        }
        if (command.includes("if [ ! -e")) {
          return {
            stdout: "f|-rw-r--r--|4|1700000000|/home/agent/agent.txt\n",
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        commands.push(command);
        const stream = createMockStream();
        if (command.includes("scp -t")) {
          setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          stream.on("_write", (buf) => {
            const text = buf.toString("utf8");
            if (text.startsWith("C") || (buf.length === 1 && buf[0] === 0x00)) {
              setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
            }
          });
        } else if (command.includes("scp -f")) {
          let ackCount = 0;
          stream.on("_write", (buf) => {
            if (!(buf[0] === SCP_OK && buf.length === 1)) return;
            ackCount += 1;
            if (ackCount === 1) {
              setImmediate(() => {
                stream.pushFromRemote(buildFileControlLine({ mode: 0o644, size: 4, name: "agent.txt" }));
              });
            } else if (ackCount === 2) {
              setImmediate(() => {
                stream.pushFromRemote(Buffer.concat([Buffer.from("data"), Buffer.from([0x00])]));
              });
            }
          });
        }
        return stream;
      },
    });

    const client = {
      client: { exec: () => {} },
      sftp: null,
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
      async end() {},
    };
    sftpClients.set("scp-session-1", client);

    // Minimal ctx for createFileOpsApi — only what list/mkdir/rename/delete/write need
    api = createFileOpsApi({
      get sftpClients() { return sftpClients; },
      get electronModule() {
        return {
          webContents: { fromId: () => ({ send: () => {} }) },
        };
      },
      fileWatcherBridge: { stopWatchersForSession: () => {} },
      fs,
      path,
      Buffer,
      console,
      setTimeout,
      clearTimeout,
      jumpConnectionsMap: new Map(),
      sftpEncodingState: new Map(),
      normalizeEncoding: (e) => e || "utf-8",
      isAsciiString: () => true,
      requireSftpChannel: async () => { throw new Error("should not use SFTP channel in SCP mode"); },
      resolveEncodingForRequest: () => "utf-8",
      updateResolvedEncoding: () => "utf-8",
      encodePath: (p) => p,
      decodeName: (n) => n,
      detectEncodingFromList: () => null,
      statResultFromAttrs: (a) => a,
      normalizeRemotePathString: async (_c, p) => p,
      collectReadable: async () => Buffer.alloc(0),
      writeToWritable: async () => {},
      throwIfAborted: () => {},
      pipeStreams: async () => {},
      ensureRemoteDirForSession: async () => true,
      removeRemotePathInternal: async () => {},
      renameRemotePath: async () => {},
      realpathAsync: async () => "/",
      statAsync: async () => ({}),
      readdirAsync: async () => [],
      mkdirAsync: async () => {},
      rmdirAsync: async () => {},
      unlinkAsync: async () => {},
      openFileAsync: async () => ({}),
      writeFileChunkAsync: async () => {},
      closeFileAsync: async () => {},
      createAbortError: (s, m) => new Error(m),
      copySftpEncodingState: () => {},
      clearSftpEncodingState: () => {},
      safeSend: () => {},
      tempDirBridge: { getTempFilePath: (n) => path.join(tmpDir, n) },
      randomUUID: () => "test-uuid",
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("marks clients as SCP-mode", () => {
    assert.equal(isScpModeClient(sftpClients.get("scp-session-1")), true);
  });

  it("list works for SCP-mode session id (AI sftp.list path)", async () => {
    const entries = await api.listSftp(null, { sftpId: "scp-session-1", path: "/home/agent" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "agent.txt");
    assert.ok(commands.some((c) => c.includes("cd ") || c.includes("for f in")));
  });

  it("mkdir write-class op works for SCP-mode session (AI sftp.mkdir path)", async () => {
    const ok = await api.mkdirSftp(null, { sftpId: "scp-session-1", path: "/home/agent/newdir" });
    assert.equal(ok, true);
    assert.ok(commands.some((c) => c.includes("mkdir") && c.includes("/home/agent/newdir")));
  });

  it("rename and delete work for SCP-mode session", async () => {
    await api.renameSftp(null, {
      sftpId: "scp-session-1",
      oldPath: "/home/agent/a",
      newPath: "/home/agent/b",
    });
    await api.deleteSftp(null, { sftpId: "scp-session-1", path: "/home/agent/b" });
    assert.ok(commands.some((c) => c.includes("mv --")));
    assert.ok(commands.some((c) => c.includes("rm ")));
  });

  it("write + homeDir work for SCP-mode session", async () => {
    await api.writeSftp(null, {
      sftpId: "scp-session-1",
      path: "/home/agent/out.txt",
      content: "hi\n",
    });
    assert.ok(commands.some((c) => c.includes("scp -t")));
    const home = await api.getSftpHomeDir(null, { sftpId: "scp-session-1" });
    assert.equal(home.success, true);
    assert.equal(home.homeDir, "/home/agent");
  });

  it("capability catalog still exposes stable sftp.* CLI verbs", () => {
    const { SFTP_CAPABILITIES } = require("../../capabilities/catalog/sftp.cjs");
    const ids = SFTP_CAPABILITIES.map((c) => c.id);
    for (const id of [
      "sftp.list",
      "sftp.mkdir",
      "sftp.write",
      "sftp.upload",
      "sftp.download",
      "sftp.delete",
      "sftp.rename",
    ]) {
      assert.ok(ids.includes(id), `missing capability ${id}`);
    }
    const listCap = SFTP_CAPABILITIES.find((c) => c.id === "sftp.list");
    assert.deepEqual(listCap.surfaces.cli.command, ["sftp", "list"]);
    assert.match(listCap.description, /SCP-mode/i);
  });
});
}
