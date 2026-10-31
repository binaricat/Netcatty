"use strict";

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
