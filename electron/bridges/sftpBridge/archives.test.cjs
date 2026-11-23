"use strict";

// --- merged from archiveCreate.test.cjs ---
{
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  validateArchiveCreateOptions,
  buildCreateArchiveCommand,
  parseCreateArchiveResult,
} = require("./archiveCreate.cjs");

const posix = process.platform !== "win32";
const baseOptions = { directory: "/tmp/example", paths: ["file"], archiveName: "bundle.tar.gz", format: "tar.gz" };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-archive-create-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function execute(options, env = {}) {
  return spawnSync("/bin/sh", ["-c", buildCreateArchiveCommand(options)], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
}

function assertNoStaging(directory) {
  assert.deepEqual(fs.readdirSync(directory).filter((entry) => entry.startsWith(".netcatty-archive.")), []);
}

function executablePath(name) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  assert.equal(result.status, 0, `Missing test prerequisite ${name}`);
  return result.stdout.trim();
}

function writeTool(directory, name, body) {
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

test("archive sources are relative, bounded, deduplicated and cannot contain the output", () => {
  assert.deepEqual(validateArchiveCreateOptions({ ...baseOptions, paths: ["dir/child", "dir", "./other", "other"] }).paths, ["dir", "other"]);
  for (const paths of [[], ["."], ["dir/.."], ["../file"], ["/file"], ["dir/../../file"], ["bundle.tar.gz"], ["bundle.tar.gz/file"], ["bad\\name"], ["bad\nname"], ["bad\0name"]]) {
    assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, paths }));
  }
  assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, paths: Array(1001).fill("file") }));
  assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, directory: "." }));
  assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, overwrite: "yes" }));
});

test("archive names are simple names matching an explicitly allowed format", () => {
  for (const archiveName of ["", ".", "..", ".tar.gz", "../x.tar.gz", "sub/x.tar.gz", "sub\\x.tar.gz", "a\n.tar.gz", "x.zip"]) {
    assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, archiveName }));
  }
  assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, format: "rar" }));
  assert.throws(() => validateArchiveCreateOptions({ ...baseOptions, format: "zip", archiveName: ".zip" }));
  assert.doesNotThrow(() => validateArchiveCreateOptions({ ...baseOptions, archiveName: "-quoted ' $(touch nope).tar.gz" }));
});

test("the remote result must contain a completion marker, with a distinct conflict result", () => {
  assert.deepEqual(parseCreateArchiveResult("banner\nNETCATTY_ARCHIVE_RESULT:OK\n"), { success: true });
  assert.equal(parseCreateArchiveResult("NETCATTY_ARCHIVE_RESULT:EEXIST\n").code, "EEXIST");
  assert.throws(() => parseCreateArchiveResult(""), /did not confirm/);
  assert.throws(() => parseCreateArchiveResult("ordinary output"), /did not confirm/);
});

test("GB18030 paths use the existing encoded shell quoting", () => {
  const command = buildCreateArchiveCommand({ ...baseOptions, paths: ["\u6d4b\u8bd5.txt"] }, { encoding: "gb18030" });
  const iconv = require("iconv-lite");
  assert.ok(command.includes(iconv.encode("./\u6d4b\u8bd5.txt", "gb18030").toString("base64")));
  assert.ok(command.includes("base64 -d"));
  assert.ok(!command.includes("\u6d4b\u8bd5.txt"));
});

for (const format of ["tar.gz", "zip"]) {
  test(`${format}: real archive round trip preserves selected files, folders and symlinks`, { skip: !posix }, (t) => {
    const directory = fixture(t);
    const names = ["simple.txt", "space ' quote.txt", "$(touch HACKED).txt", "`touch HACKED2`.txt", "-option", "literal*.txt", "[abc].txt", "\u4e2d\u6587.txt"];
    for (const name of names) fs.writeFileSync(path.join(directory, name), `contents of ${name}`);
    fs.writeFileSync(path.join(directory, "literal-other.txt"), "unselected");
    fs.writeFileSync(path.join(directory, "a.txt"), "unselected");
    fs.mkdirSync(path.join(directory, "folder", "empty"), { recursive: true });
    fs.writeFileSync(path.join(directory, "folder", "nested.txt"), "nested data");
    fs.mkdirSync(path.join(directory, "tree"));
    fs.writeFileSync(path.join(directory, "tree", "selected.txt"), "nested selection");
    fs.writeFileSync(path.join(directory, "tree", "excluded.txt"), "not selected");
    fs.symlinkSync(".", path.join(directory, "loop"));
    fs.symlinkSync("missing-target", path.join(directory, "broken"));
    const archiveName = `-backup ' quoted.${format}`;
    const result = execute({ directory, paths: [...names, "folder", "folder/nested.txt", "tree/selected.txt", "loop", "broken"], archiveName, format });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseCreateArchiveResult(result.stdout), { success: true });
    const output = path.join(directory, "unpacked");
    fs.mkdirSync(output);
    const unpack = format === "zip"
      ? spawnSync("unzip", ["-q", path.join(directory, archiveName), "-d", output], { encoding: "utf8" })
      : spawnSync("tar", ["-xzf", path.join(directory, archiveName), "-C", output], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    for (const name of names) {
      assert.equal(fs.readFileSync(path.join(output, name), "utf8"), `contents of ${name}`);
      assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), `contents of ${name}`);
    }
    assert.equal(fs.readFileSync(path.join(output, "folder", "nested.txt"), "utf8"), "nested data");
    assert.ok(fs.statSync(path.join(output, "folder", "empty")).isDirectory());
    assert.equal(fs.readFileSync(path.join(output, "tree", "selected.txt"), "utf8"), "nested selection");
    for (const missing of ["literal-other.txt", "a.txt", "tree/excluded.txt", "HACKED", "HACKED2", archiveName]) {
      assert.equal(fs.existsSync(path.join(output, missing)), false, missing);
    }
    assert.equal(fs.readlinkSync(path.join(output, "loop")), ".");
    assert.equal(fs.readlinkSync(path.join(output, "broken")), "missing-target");
    assert.equal(fs.existsSync(path.join(directory, "HACKED")), false);
    assert.equal(fs.existsSync(path.join(directory, "HACKED2")), false);
    assertNoStaging(directory);
  });
}

test("existing output requires confirmation; confirmed replacement leaves original inputs intact", { skip: !posix }, (t) => {
  const directory = fixture(t);
  const options = { ...baseOptions, directory };
  fs.writeFileSync(path.join(directory, "file"), "source");
  fs.writeFileSync(path.join(directory, options.archiveName), "old archive");
  const conflict = execute(options);
  assert.equal(conflict.status, 0, conflict.stderr);
  assert.equal(parseCreateArchiveResult(conflict.stdout).code, "EEXIST");
  assert.equal(fs.readFileSync(path.join(directory, options.archiveName), "utf8"), "old archive");
  const replacement = execute({ ...options, overwrite: true });
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.deepEqual(parseCreateArchiveResult(replacement.stdout), { success: true });
  assert.equal(fs.readFileSync(path.join(directory, "file"), "utf8"), "source");
  const listed = spawnSync("tar", ["-tzf", path.join(directory, options.archiveName)], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /file/);
  assertNoStaging(directory);
});

test("directories and symbolic-link outputs are never overwritten", { skip: !posix }, (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "file"), "source");
  fs.writeFileSync(path.join(directory, "important"), "untouched");
  fs.mkdirSync(path.join(directory, "directory.tar.gz"));
  fs.symlinkSync("important", path.join(directory, "symlink.tar.gz"));
  fs.symlinkSync("missing", path.join(directory, "broken.tar.gz"));
  for (const archiveName of ["directory.tar.gz", "symlink.tar.gz", "broken.tar.gz"]) {
    const result = execute({ ...baseOptions, directory, archiveName, overwrite: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular file/);
  }
  assert.equal(fs.readFileSync(path.join(directory, "important"), "utf8"), "untouched");
  assert.equal(fs.readlinkSync(path.join(directory, "symlink.tar.gz")), "important");
  assertNoStaging(directory);
});

test("a nested tree selection cannot traverse a symbolic link", { skip: !posix }, (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "file"), "source");
  fs.symlinkSync(".", path.join(directory, "loop"));
  const result = execute({ ...baseOptions, directory, paths: ["loop/file"] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /traverses a symbolic link/);
  assert.equal(fs.existsSync(path.join(directory, baseOptions.archiveName)), false);
});

test("an output that aliases a selected source cannot be replaced", { skip: !posix }, (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "file"), "source");
  fs.linkSync(path.join(directory, "file"), path.join(directory, baseOptions.archiveName));
  const result = execute({ ...baseOptions, directory, overwrite: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refers to a selected source/);
  assert.equal(fs.readFileSync(path.join(directory, "file"), "utf8"), "source");
  assert.equal(fs.readFileSync(path.join(directory, baseOptions.archiveName), "utf8"), "source");
  assertNoStaging(directory);
});

test("missing tools and missing inputs fail without creating an output", { skip: !posix }, (t) => {
  const directory = fixture(t);
  const missing = execute({ ...baseOptions, directory });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /source no longer exists/);
  fs.writeFileSync(path.join(directory, "file"), "source");
  for (const format of ["tar.gz", "zip"]) {
    const noTool = execute({ ...baseOptions, directory, archiveName: `bundle.${format}`, format }, { PATH: directory });
    assert.notEqual(noTool.status, 0);
    assert.match(noTool.stderr, /(?:tar|zip) is not installed/);
  }
  assert.equal(fs.existsSync(path.join(directory, baseOptions.archiveName)), false);
  assertNoStaging(directory);
});

test("compression and publication failures preserve the previous archive and clean staging", { skip: !posix }, (t) => {
  for (const tool of ["tar", "zip", "mv"]) {
    const directory = fixture(t);
    fs.writeFileSync(path.join(directory, "file"), "source");
    const format = tool === "zip" ? "zip" : "tar.gz";
    const archiveName = `bundle.${format}`;
    fs.writeFileSync(path.join(directory, archiveName), "old archive");
    const envPath = writeTool(directory, tool, "echo 'intentional failure' >&2\nexit 9");
    const result = execute({ ...baseOptions, directory, archiveName, format, overwrite: true }, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(directory, archiveName), "utf8"), "old archive");
    assert.equal(fs.readFileSync(path.join(directory, "file"), "utf8"), "source");
    assertNoStaging(directory);
  }
});

test("unreadable nested files fail the real tools instead of publishing a partial archive", {
  skip: !posix || process.getuid?.() === 0,
}, (t) => {
  for (const format of ["tar.gz", "zip"]) {
    const directory = fixture(t);
    fs.mkdirSync(path.join(directory, "folder"));
    fs.writeFileSync(path.join(directory, "folder", "readable"), "readable data");
    const unreadable = path.join(directory, "folder", "unreadable");
    fs.writeFileSync(unreadable, "protected data", { mode: 0o000 });
    t.after(() => { try { fs.chmodSync(unreadable, 0o600); } catch { /* fixture may already be removed */ } });
    const archiveName = `bundle.${format}`;
    fs.writeFileSync(path.join(directory, archiveName), "previous archive");
    const result = execute({ directory, paths: ["folder"], archiveName, format, overwrite: true });
    assert.notEqual(result.status, 0, `${format} must report unreadable input`);
    assert.equal(fs.readFileSync(path.join(directory, archiveName), "utf8"), "previous archive");
    assertNoStaging(directory);
  }
});

test("a competing creator immediately before publication cannot be overwritten", { skip: !posix }, (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "file"), "source");
  const realLn = executablePath("ln");
  const envPath = writeTool(directory, "ln", `printf 'competing archive' > './bundle.tar.gz'\nexec '${realLn}' "$@"`);
  const result = execute({ ...baseOptions, directory }, { PATH: envPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseCreateArchiveResult(result.stdout).code, "EEXIST");
  assert.equal(fs.readFileSync(path.join(directory, baseOptions.archiveName), "utf8"), "competing archive");
  assertNoStaging(directory);
});

test("publication never redirects into a directory or directory symlink created concurrently", { skip: !posix }, (t) => {
  for (const symlink of [false, true]) {
    const directory = fixture(t);
    fs.writeFileSync(path.join(directory, "file"), "source");
    fs.mkdirSync(path.join(directory, "other"));
    const realLn = executablePath("ln");
    const setup = symlink ? `'${realLn}' -s other bundle.tar.gz` : "mkdir bundle.tar.gz";
    const envPath = writeTool(directory, "ln", `${setup}\nexec '${realLn}' "$@"`);
    const result = execute({ ...baseOptions, directory }, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(path.join(directory, symlink ? "other" : "bundle.tar.gz")), []);
    assertNoStaging(directory);
  }
});
}

// --- merged from archiveExtract.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getArchiveKind,
  isExtractableArchive,
  posixParentDir,
  stripCompressionSuffix,
  computeExtractTimeoutMs,
  buildExtractCommand,
  buildLocalExtractPlan,
  EXTRACT_MAX_TIMEOUT_MS,
} = require("./archiveExtract.cjs");

test("detects compound archive suffixes before single-file compression", () => {
  assert.equal(getArchiveKind("backup.tar.gz"), "tar.gz");
  assert.equal(getArchiveKind("/var/a.tgz"), "tar.gz");
  assert.equal(getArchiveKind("logs.tar.bz2"), "tar.bz2");
  assert.equal(getArchiveKind("src.tar.xz"), "tar.xz");
  assert.equal(getArchiveKind("app.tar"), "tar");
  assert.equal(getArchiveKind("payload.zip"), "zip");
  assert.equal(getArchiveKind("notes.txt.gz"), "gz");
  assert.equal(getArchiveKind("notes.txt"), null);
  assert.equal(getArchiveKind(".gz"), null);
  assert.equal(isExtractableArchive("bundle.tgz"), true);
  assert.equal(isExtractableArchive("readme.md"), false);
});

test("posix parent and gzip output stay in the archive directory", () => {
  assert.equal(posixParentDir("/home/app/a.tar.gz"), "/home/app");
  assert.equal(posixParentDir("/a.zip"), "/");
  assert.equal(stripCompressionSuffix("/home/app/notes.txt.gz", "gz"), "/home/app/notes.txt");
  assert.equal(stripCompressionSuffix("/notes.txt.gz", "gz"), "/notes.txt");
});

test("extract commands quote spaces and single quotes", () => {
  const tarCmd = buildExtractCommand("/tmp/my files/app's.tgz");
  assert.match(tarCmd, /tar -xzf '/);
  assert.match(tarCmd, /'\/tmp\/my files\/app'\\''s\.tgz'/);
  assert.match(tarCmd, /-C '\/tmp\/my files'/);

  const zipCmd = buildExtractCommand("/opt/build/out.zip");
  assert.match(zipCmd, /unzip -qo '\/opt\/build\/out\.zip' -d '\/opt\/build' >\/dev\/null/);
  assert.match(zipCmd, /tar -xf '\/opt\/build\/out\.zip' -C '\/opt\/build'/);

  const gzCmd = buildExtractCommand("/var/log/syslog.gz");
  assert.match(gzCmd, /out='\/var\/log\/syslog'/);
  assert.match(gzCmd, /archive='\/var\/log\/syslog\.gz'/);
  assert.match(gzCmd, /trap 'rm -f -- "\$stage"' EXIT/);
  assert.match(gzCmd, /gzip -dc -- "\$archive" > "\$stage"/);
  assert.match(gzCmd, /if \[ -d "\$out" \]/);
  assert.match(gzCmd, /mv -f -- "\$stage" "\$out"/);

  const spacedGz = buildExtractCommand("/tmp/my file.txt.gz");
  assert.match(spacedGz, /out='\/tmp\/my file\.txt'/);
  assert.match(spacedGz, /archive='\/tmp\/my file\.txt\.gz'/);
  assert.doesNotMatch(spacedGz, /trap 'rm -f -- '/);
});

test("generated gzip extract script can install its EXIT trap with spaces in the path", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-trap-"));
  const archive = path.join(dir, "my file.txt.gz");
  fs.writeFileSync(archive, "x");
  const cmd = buildExtractCommand(archive);
  const prefix = [];
  for (const line of cmd.split("\n")) {
    prefix.push(line);
    if (line.startsWith("trap ")) break;
  }
  prefix.push("trap - EXIT");
  prefix.push("rm -f -- \"$stage\"");
  const ran = spawnSync("sh", ["-c", prefix.join("\n")], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extract command rejects newlines and unknown types", () => {
  assert.throws(() => buildExtractCommand("/tmp/bad\n.tar.gz"), /NUL or newlines/);
  assert.throws(() => buildExtractCommand("/tmp/notes.txt"), /Unsupported archive type/);
});

test("local extract plan uses unzip with tar fallback off Windows", () => {
  const unixZip = buildLocalExtractPlan("/tmp/a.zip", "linux");
  assert.deepEqual(unixZip.command, "unzip");
  assert.deepEqual(unixZip.args, ["-qo", "/tmp/a.zip", "-d", "/tmp"]);
  assert.deepEqual(unixZip.fallback, { command: "tar", args: ["-xf", "/tmp/a.zip", "-C", "/tmp"] });

  const winZip = buildLocalExtractPlan("C:\\tmp\\a.zip", "win32");
  assert.equal(winZip.command, "tar");
  assert.ok(winZip.args.includes("-xf"));

  const gz = buildLocalExtractPlan("/tmp/notes.txt.gz", "win32");
  assert.equal(gz.builtin, "gunzip");
  assert.equal(gz.archivePath, "/tmp/notes.txt.gz");
  assert.equal(gz.stdoutFile, "/tmp/notes.txt");
});

test("unknown archive size uses the maximum extract timeout", () => {
  assert.equal(computeExtractTimeoutMs(undefined), EXTRACT_MAX_TIMEOUT_MS);
  assert.ok(computeExtractTimeoutMs(1024) < EXTRACT_MAX_TIMEOUT_MS);
});

test("extractLocalArchiveFile unpacks a tar.gz next to the archive", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { extractLocalArchiveFile } = require("./archiveExtract.cjs");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-extract-"));
  const source = path.join(dir, "hello.txt");
  const archive = path.join(dir, "hello.tgz");
  fs.writeFileSync(source, "hello-extract");
  const packed = spawnSync("tar", ["-czf", archive, "-C", dir, "hello.txt"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  fs.unlinkSync(source);

  await extractLocalArchiveFile(archive);
  assert.equal(fs.readFileSync(source, "utf8"), "hello-extract");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failed gzip extract leaves an existing sibling file intact", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { extractLocalArchiveFile } = require("./archiveExtract.cjs");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-extract-keep-"));
  const dest = path.join(dir, "notes.txt");
  const archive = path.join(dir, "notes.txt.gz");
  fs.writeFileSync(dest, "keep-me");
  fs.writeFileSync(archive, "this-is-not-gzip");

  await assert.rejects(() => extractLocalArchiveFile(archive), /Local extraction failed/);
  assert.equal(fs.readFileSync(dest, "utf8"), "keep-me");
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes(".netcatty-extract")),
    [],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extractLocalArchiveFile gunzips with Node zlib and keeps a sibling staging name", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const zlib = require("node:zlib");
  const { extractLocalArchiveFile } = require("./archiveExtract.cjs");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-extract-gz-"));
  const dest = path.join(dir, "notes.txt");
  const archive = path.join(dir, "notes.txt.gz");
  const sibling = `${dest}.netcatty-extract`;
  fs.writeFileSync(sibling, "do-not-touch");
  fs.writeFileSync(archive, zlib.gzipSync("hello-gzip"));

  await extractLocalArchiveFile(archive);
  assert.equal(fs.readFileSync(dest, "utf8"), "hello-gzip");
  assert.equal(fs.readFileSync(sibling, "utf8"), "do-not-touch");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failed gzip extract leaves a sibling directory target intact", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const zlib = require("node:zlib");
  const { extractLocalArchiveFile } = require("./archiveExtract.cjs");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-extract-dir-"));
  const dest = path.join(dir, "notes.txt");
  const archive = path.join(dir, "notes.txt.gz");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "keep.txt"), "inside");
  fs.writeFileSync(archive, zlib.gzipSync("hello-gzip"));

  await assert.rejects(() => extractLocalArchiveFile(archive), /directory/);
  assert.equal(fs.readFileSync(path.join(dest, "keep.txt"), "utf8"), "inside");
  fs.rmSync(dir, { recursive: true, force: true });
});
}

// --- merged from fileOps.createArchive.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");
const { createFileOpsApi } = require("./fileOps.cjs");
const { createPreloadApi } = require("../../preload/api.cjs");

const options = { directory: "/home/app", paths: ["file", "folder"], archiveName: "backup.tar.gz", format: "tar.gz" };

function createApi({ client = { client: { exec() {} } }, stdout = "NETCATTY_ARCHIVE_RESULT:OK\n", error, encoding = "utf-8" } = {}) {
  const calls = [];
  const api = createFileOpsApi({
    sftpClients: new Map(client ? [["sftp-1", client]] : []),
    resolveEncodingForRequest: () => encoding,
    throwIfAborted(signal) { if (signal?.aborted) throw new Error("Aborted"); },
    execRemoteShellCommand: async (sshClient, command, execOptions) => {
      calls.push({ sshClient, command, options: execOptions });
      if (error) throw error;
      return { stdout, code: 0 };
    },
  });
  return { api, calls };
}

test("archive creation passes options through preload and the bounded remote executor", async () => {
  const { api, calls } = createApi();
  let invoked;
  const bridge = createPreloadApi({
    ipcRenderer: {
      on() {},
      invoke(channel, payload) {
        invoked = { channel, payload };
        return api.createSftpArchive(null, payload);
      },
    },
    webUtils: {},
  });
  assert.deepEqual(await bridge.createSftpArchive("sftp-1", options, "utf-8"), { success: true });
  assert.equal(invoked.channel, "netcatty:sftp:createArchive");
  assert.deepEqual(invoked.payload, { sftpId: "sftp-1", options, encoding: "utf-8" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /tar -czf/);
  assert.equal(calls[0].options.openingTimeoutMs, 15_000);
  assert.equal(calls[0].options.runTimeoutMs, 30 * 60_000);
  assert.equal(calls[0].options.maxOutputBytes, 64 * 1024);
});

test("archive conflicts survive IPC as structured EEXIST results", async () => {
  const { api } = createApi({ stdout: "NETCATTY_ARCHIVE_RESULT:EEXIST\n" });
  const result = await api.createSftpArchive(null, { sftpId: "sftp-1", options });
  assert.equal(result.success, false);
  assert.equal(result.code, "EEXIST");
});

test("archive creation requires a session and exec channel", async () => {
  const missing = createApi({ client: null });
  await assert.rejects(() => missing.api.createSftpArchive(null, { sftpId: "none", options }), /session not found/);
  const noExec = createApi({ client: {} });
  await assert.rejects(() => noExec.api.createSftpArchive(null, { sftpId: "sftp-1", options }), /SSH exec unavailable/);
  assert.equal(missing.calls.length + noExec.calls.length, 0);
});

test("archive creation never opens a second channel on single-channel SSH", async () => {
  for (const client of [
    { __netcattySingleChannelSsh: true, client: { exec() {} } },
    { client: { __netcattySingleChannelSsh: true, exec() {} } },
  ]) {
    const { api, calls } = createApi({ client });
    await assert.rejects(
      () => api.createSftpArchive(null, { sftpId: "sftp-1", options }),
      (error) => error.code === "ERR_SFTP_SINGLE_CHANNEL_EXEC",
    );
    assert.equal(calls.length, 0);
  }
});

test("invalid sources and cancelled requests never execute a shell command", async () => {
  const { api, calls } = createApi();
  await assert.rejects(() => api.createSftpArchive(null, { sftpId: "sftp-1", options: { ...options, paths: ["../outside"] } }), /inside/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => api.createSftpArchive(null, { sftpId: "sftp-1", options, abortSignal: abort.signal }), /Aborted/);
  assert.equal(calls.length, 0);
});

test("remote errors or missing completion acknowledgements cannot report success", async () => {
  const failure = createApi({ error: new Error("zip unavailable") });
  await assert.rejects(() => failure.api.createSftpArchive(null, { sftpId: "sftp-1", options }), /zip unavailable/);
  const incomplete = createApi({ stdout: "" });
  await assert.rejects(() => incomplete.api.createSftpArchive(null, { sftpId: "sftp-1", options }), /did not confirm/);
});

test("archive creation resolves the session's filename encoding", async () => {
  const { api, calls } = createApi({ encoding: "gb18030" });
  await api.createSftpArchive(null, { sftpId: "sftp-1", options: { ...options, paths: ["\u4e2d\u6587"] }, encoding: "auto" });
  assert.match(calls[0].command, /base64 -d/);
  assert.ok(!calls[0].command.includes("\u4e2d\u6587"));
});
}

// --- merged from fileOps.createArchive.ssh.test.cjs ---
{
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { Client, Server, utils } = require("ssh2");
const { createFileOpsApi } = require("./fileOps.cjs");
const { _execRemoteShellCommandForTests: execRemoteShellCommand } = require("../sftpBridge.cjs");

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** A real encrypted loopback SSH transport; exec runs only inside our fixture. */
async function connectFixture(t) {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const hostFingerprint = createHash("sha256").update(utils.parseKey(hostKey).getPublicSSH()).digest("hex");
  const password = randomBytes(16).toString("hex");
  const connections = new Set();
  const children = new Set();
  const fixture = { env: process.env, commands: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    connection.on("authentication", (context) => {
      if (context.method === "password" && context.username === "archive-test" && context.password === password) context.accept();
      else context.reject();
    });
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        fixture.commands += 1;
        const channel = acceptExec();
        const child = spawn("/bin/sh", ["-c", info.command], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
        children.add(child);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        channel.on("error", () => {});
        child.on("error", (error) => {
          channel.stderr.write(error.message);
          channel.exit(127);
          channel.end(() => channel.close());
        });
        child.on("close", (code) => {
          children.delete(child);
          channel.exit(code ?? 1);
          channel.end(() => channel.close());
        });
        channel.on("close", () => { if (child.exitCode === null) child.kill("SIGKILL"); });
      });
    }));
  });
  const client = new Client();
  t.after(async () => {
    client.destroy();
    for (const child of children) child.kill("SIGKILL");
    for (const connection of connections) connection.end();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect({
      host: "127.0.0.1",
      port: server.address().port,
      username: "archive-test",
      password,
      hostHash: "sha256",
      hostVerifier: (hash) => hash === hostFingerprint,
      readyTimeout: 5000,
    });
  });
  const api = createFileOpsApi({
    sftpClients: new Map([["loopback", { client }]]),
    resolveEncodingForRequest: () => "utf-8",
    throwIfAborted(signal) { if (signal?.aborted) throw new Error("Aborted"); },
    execRemoteShellCommand,
  });
  return { ...fixture, setEnv: (env) => { fixture.env = env; }, getCommandCount: () => fixture.commands, api };
}

test("archive creation traverses real SSH, preserves payloads, and handles conflict/replace/failure", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-archive-ssh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "folder"));
  const binary = randomBytes(65_537);
  fs.writeFileSync(path.join(directory, "folder", "binary.bin"), binary);
  const sourceName = "\u4e2d\u6587 ' $(touch should-not-exist).txt";
  fs.writeFileSync(path.join(directory, sourceName), "before replacement");
  const { api, setEnv, getCommandCount } = await connectFixture(t);
  for (const format of ["tar.gz", "zip"]) {
    const archiveName = `transport.${format}`;
    const options = { directory, paths: [sourceName, "folder"], archiveName, format };
    const invoke = (patch = {}) => api.createSftpArchive(null, { sftpId: "loopback", options: { ...options, ...patch } });
    assert.deepEqual(await invoke(), { success: true });
    const archivePath = path.join(directory, archiveName);
    const firstDigest = sha256(archivePath);
    fs.writeFileSync(path.join(directory, sourceName), `after replacement ${format}`);
    assert.equal((await invoke()).code, "EEXIST");
    assert.equal(sha256(archivePath), firstDigest);
    assert.deepEqual(await invoke({ overwrite: true }), { success: true });
    assert.notEqual(sha256(archivePath), firstDigest);
    const unpacked = path.join(directory, `unpacked-${format}`);
    fs.mkdirSync(unpacked);
    const unpack = format === "zip"
      ? spawnSync("unzip", ["-q", archivePath, "-d", unpacked], { encoding: "utf8" })
      : spawnSync("tar", ["-xzf", archivePath, "-C", unpacked], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    assert.deepEqual(fs.readFileSync(path.join(unpacked, "folder", "binary.bin")), binary);
    assert.equal(fs.readFileSync(path.join(unpacked, sourceName), "utf8"), `after replacement ${format}`);
    assert.equal(fs.existsSync(path.join(directory, "should-not-exist")), false);
    const completedDigest = sha256(archivePath);
    await assert.rejects(() => invoke({ overwrite: true, paths: ["missing"] }), /source no longer exists/);
    assert.equal(sha256(archivePath), completedDigest);
    setEnv({ ...process.env, PATH: directory });
    await assert.rejects(() => invoke({ overwrite: true }), /is not installed on the remote host/);
    setEnv(process.env);
    assert.equal(sha256(archivePath), completedDigest);
    assert.deepEqual(fs.readdirSync(directory).filter((entry) => entry.startsWith(".netcatty-archive.")), []);
  }
  assert.equal(getCommandCount(), 10);
});
}

// --- merged from fileOps.extract.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");

const { createFileOpsApi } = require("./fileOps.cjs");

function createExtractApi({ execImpl, clients } = {}) {
  const commands = [];
  const optionsLog = [];
  const api = createFileOpsApi({
    sftpClients: clients || new Map([
      ["sftp-1", { client: { exec() {} } }],
    ]),
    resolveEncodingForRequest: () => "utf-8",
    throwIfAborted: () => {},
    encodePath: (value) => value,
    requireSftpChannel: async () => ({}),
    lstatAsync: async () => ({ size: 1024 }),
    isScpModeClient: () => false,
    execRemoteShellCommand: async (_ssh, command, options) => {
      commands.push(command);
      optionsLog.push(options);
      if (typeof execImpl === "function") return execImpl(command);
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  return { api, commands, optionsLog };
}

test("extractSftpArchive runs a quoted remote tar command", async () => {
  const { api, commands, optionsLog } = createExtractApi();
  const result = await api.extractSftpArchive(null, {
    sftpId: "sftp-1",
    path: "/home/app/backup.tar.gz",
  });
  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /tar -xzf '\/home\/app\/backup\.tar\.gz' -C '\/home\/app'/);
  assert.equal(optionsLog[0].discardStdout, true);
});

test("extractSftpArchive rejects unsupported files", async () => {
  const { api, commands } = createExtractApi();
  await assert.rejects(
    () => api.extractSftpArchive(null, { sftpId: "sftp-1", path: "/home/app/notes.txt" }),
    /Unsupported archive type/,
  );
  assert.equal(commands.length, 0);
});

test("extractSftpArchive requires an open SFTP session", async () => {
  const { api } = createExtractApi({ clients: new Map() });
  await assert.rejects(
    () => api.extractSftpArchive(null, { sftpId: "missing", path: "/tmp/a.zip" }),
    /SFTP session not found/,
  );
});


test("extractSftpArchive refuses a second channel on single-channel SSH", async () => {
  let execCalls = 0;
  const { api, commands } = createExtractApi({
    clients: new Map([[
      "sftp-1",
      {
        __netcattySingleChannelSsh: true,
        __netcattyEndpointKey: "ep-extract",
        client: { exec() { execCalls += 1; } },
      },
    ]]),
  });
  await assert.rejects(
    () => api.extractSftpArchive(null, {
      sftpId: "sftp-1",
      path: "/home/app/backup.tar.gz",
    }),
    (err) => err && err.code === "ERR_SFTP_SINGLE_CHANNEL_EXEC",
  );
  assert.equal(commands.length, 0);
  assert.equal(execCalls, 0);
});
}
