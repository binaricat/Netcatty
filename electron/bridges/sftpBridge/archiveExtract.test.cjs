"use strict";

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
