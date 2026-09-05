const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectLocalTreeEntries,
  MAX_LOCAL_TREE_DIRECTORIES,
  MAX_LOCAL_TREE_ENTRIES,
  WINDOWS_ATTRIB_TIMEOUT_MS,
  parseAttribOutput,
  listWindowsHiddenBasenames,
  statLocal,
  lstatLocal,
  deleteLocalFile,
} = require("./localFsBridge.cjs");

test("local tree traversal defaults match the remote traversal safety budget", () => {
  assert.equal(MAX_LOCAL_TREE_DIRECTORIES, 50_000);
  assert.equal(MAX_LOCAL_TREE_ENTRIES, 200_000);
});

test("expected symlink delete refuses a replacement file", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-delete-type-"));
  const target = path.join(root, "target");
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.writeFile(target, "new owner");

  await assert.rejects(
    () => deleteLocalFile(null, { path: target, expectedType: "symlink" }),
    (error) => {
      assert.equal(error.code, "ESTALE");
      return true;
    },
  );
  assert.equal(await fs.promises.readFile(target, "utf8"), "new owner");
});

test("parseAttribOutput returns an empty set for empty input", () => {
  assert.equal(parseAttribOutput("").size, 0);
  assert.equal(parseAttribOutput("\r\n\r\n").size, 0);
});

test("parseAttribOutput captures basenames of files with the H flag", () => {
  const stdout = [
    "A            C:\\Users\\foo\\public.txt",
    "     H       C:\\Users\\foo\\.secret",
    "A    H  R   C:\\Users\\foo\\hidden-readonly.exe",
    "A            C:\\Users\\foo\\another.log",
  ].join("\r\n");

  const hidden = parseAttribOutput(stdout);
  assert.deepEqual(
    [...hidden].sort(),
    [".secret", "hidden-readonly.exe"].sort(),
  );
});

test("parseAttribOutput ignores the trailing [DIR] marker on some Windows versions", () => {
  const stdout = [
    "     H       C:\\data\\node_modules                       [DIR]",
    "     H       C:\\data\\.git                               [DIR]",
    "A            C:\\data\\README.md",
  ].join("\r\n");

  const hidden = parseAttribOutput(stdout);
  assert.deepEqual([...hidden].sort(), [".git", "node_modules"].sort());
});

test("parseAttribOutput preserves filenames that legitimately end with bracketed suffixes", () => {
  // Regression: a prior version stripped ANY trailing bracketed suffix
  // via /\s+\[[^\]]+\]\s*$/, truncating "Notes [old]" to "Notes".
  // Only the literal [DIR] marker that attrib emits with /d is a parser
  // artifact; user-facing filenames with brackets must survive intact so
  // hiddenSet.has(entry.name) still matches the actual readdir entry.
  const stdout = [
    "     H       C:\\data\\Notes [old]",
    "     H       C:\\data\\Draft [v2].md",
    "     H       C:\\data\\archived [2024]",
    "     H       C:\\data\\node_modules                        [DIR]",
  ].join("\r\n");

  const hidden = parseAttribOutput(stdout);
  assert.deepEqual(
    [...hidden].sort(),
    ["Draft [v2].md", "Notes [old]", "archived [2024]", "node_modules"].sort(),
  );
});

test("parseAttribOutput handles UNC paths", () => {
  const stdout = [
    "     H       \\\\fileserver\\share\\secret.cfg",
    "A            \\\\fileserver\\share\\public.cfg",
  ].join("\r\n");

  const hidden = parseAttribOutput(stdout);
  assert.deepEqual([...hidden], ["secret.cfg"]);
});

test("parseAttribOutput skips malformed lines", () => {
  const stdout = [
    "Parameter format not correct",
    "",
    "     H       C:\\good\\hidden.txt",
    "File not found",
    "     H       not-a-windows-path.txt",
  ].join("\r\n");

  const hidden = parseAttribOutput(stdout);
  assert.deepEqual([...hidden], ["hidden.txt"]);
});

test("listWindowsHiddenBasenames returns an empty set on non-Windows without spawning anything", async () => {
  // Running this test file is only meaningful on a non-Windows host for this
  // assertion. On Windows CI we skip the subprocess-free guarantee.
  if (process.platform === "win32") return;
  const result = await listWindowsHiddenBasenames("/tmp");
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test("listWindowsHiddenBasenames invokes attrib.exe with /d so hidden directories aren't omitted", async () => {
  // Regression: without `/d`, `attrib <dir>\*` treats the wildcard as
  // file-centric and hidden directories (node_modules, .git, …) never
  // reach parseAttribOutput — the SFTP browser then shows them as
  // not-hidden, a behavior regression from the per-file implementation.
  const Module = require("node:module");
  const realChildProcess = require("node:child_process");
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  let capturedArgs = null;
  let capturedExecutable = null;
  let capturedOptions = null;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node:child_process") {
      return {
        ...realChildProcess,
        execFile: (executable, args, options, cb) => {
          capturedExecutable = executable;
          capturedArgs = args;
          capturedOptions = options;
          cb(null, { stdout: "", stderr: "" });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  Object.defineProperty(process, "platform", {
    value: "win32",
    writable: true,
    configurable: true,
  });

  const bridgePath = require.resolve("./localFsBridge.cjs");
  delete require.cache[bridgePath];

  try {
    const { listWindowsHiddenBasenames: fn } = require("./localFsBridge.cjs");
    await fn("C:\\fixture");
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    delete require.cache[bridgePath];
  }

  assert.equal(capturedExecutable, "attrib.exe");
  assert.ok(
    Array.isArray(capturedArgs) && capturedArgs.includes("/d"),
    `expected /d in attrib args so hidden directories are included, got ${JSON.stringify(capturedArgs)}`,
  );
  assert.equal(capturedOptions.timeout, WINDOWS_ATTRIB_TIMEOUT_MS);
  assert.equal(capturedOptions.maxBuffer, 64 * 1024 * 1024);
});

test("collectLocalTreeEntries preserves empty directories in selected folders", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(path.join(selected, "empty"), { recursive: true });
  await fs.promises.mkdir(path.join(selected, "src"), { recursive: true });
  await fs.promises.writeFile(path.join(selected, "src", "main.txt"), "hello");

  try {
    const entries = await collectLocalTreeEntries(selected);
    const summary = entries.map((entry) => ({
      relativePath: entry.relativePath,
      type: entry.type,
    }));

    assert.deepEqual(summary, [
      { relativePath: "project", type: "directory" },
      { relativePath: "project/empty", type: "directory" },
      { relativePath: "project/src", type: "directory" },
      { relativePath: "project/src/main.txt", type: "file" },
    ]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries reports progressive file counts during scan", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-progress-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(path.join(selected, "src"), { recursive: true });
  await fs.promises.writeFile(path.join(selected, "readme.txt"), "hi");
  await fs.promises.writeFile(path.join(selected, "src", "main.txt"), "hello");

  const progress = [];
  try {
    const entries = await collectLocalTreeEntries(selected, {}, (stats) => {
      progress.push({ ...stats });
    });
    assert.equal(entries.filter((entry) => entry.type === "file").length, 2);
    assert.ok(progress.length >= 1, "expected at least one progress event");
    const final = progress[progress.length - 1];
    assert.equal(final.fileCount, 2);
    assert.equal(final.directoryCount, 2);
    assert.equal(final.entryCount, 4);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries aborts when cancelled mid-scan", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-cancel-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(path.join(selected, "a"), { recursive: true });
  await fs.promises.mkdir(path.join(selected, "b"), { recursive: true });
  await fs.promises.writeFile(path.join(selected, "a", "1.txt"), "1");
  await fs.promises.writeFile(path.join(selected, "b", "2.txt"), "2");

  let cancel = false;
  try {
    await assert.rejects(
      () => collectLocalTreeEntries(
        selected,
        {},
        () => {
          // Cancel as soon as progress starts flowing.
          cancel = true;
        },
        () => cancel,
      ),
      /cancelled/i,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries bounds and parallelizes metadata reads within a directory", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-parallel-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(selected, { recursive: true });
  await Promise.all(Array.from({ length: 64 }, (_, index) => (
    fs.promises.writeFile(path.join(selected, `file-${String(index).padStart(3, "0")}.txt`), "x")
  )));

  const originalLstat = fs.promises.lstat;
  let active = 0;
  let maxActive = 0;
  fs.promises.lstat = async (...args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await originalLstat.apply(fs.promises, args);
    } finally {
      active -= 1;
    }
  };
  t.after(async () => {
    fs.promises.lstat = originalLstat;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const entries = await collectLocalTreeEntries(selected);
  assert.equal(entries.length, 65);
  assert.ok(maxActive > 1, `expected concurrent lstat calls, got ${maxActive}`);
  assert.ok(maxActive <= 32, `metadata concurrency must stay bounded, got ${maxActive}`);
});

test("collectLocalTreeEntries skips a child that disappears during inspection", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-vanished-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(selected, { recursive: true });
  await fs.promises.writeFile(path.join(selected, "stable.txt"), "stable");
  await fs.promises.writeFile(path.join(selected, "vanished.txt"), "vanished");

  const originalLstat = fs.promises.lstat;
  fs.promises.lstat = async (candidate, ...args) => {
    if (candidate === path.join(selected, "vanished.txt")) {
      const error = new Error("file disappeared");
      error.code = "ENOENT";
      throw error;
    }
    return originalLstat.call(fs.promises, candidate, ...args);
  };
  t.after(async () => {
    fs.promises.lstat = originalLstat;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const entries = await collectLocalTreeEntries(selected);
  assert.deepEqual(entries.map((entry) => entry.relativePath), [
    "project",
    "project/stable.txt",
  ]);
});

test("collectLocalTreeEntries does not follow a directory symlink cycle", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-cycle-"));
  const selected = path.join(root, "project");
  const nested = path.join(selected, "nested");
  await fs.promises.mkdir(nested, { recursive: true });
  try {
    await fs.promises.symlink(selected, path.join(nested, "back-to-project"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const entries = await Promise.race([
      collectLocalTreeEntries(selected),
      new Promise((_, reject) => setTimeout(() => reject(new Error("local tree scan followed a symlink cycle")), 500)),
    ]);
    const loopRows = entries.filter((entry) => entry.relativePath.endsWith("back-to-project"));
    assert.equal(loopRows.length, 0, "cyclic directory links must be skipped instead of uploaded as files");
    assert.ok(entries.length <= 3, `cycle scan must stay bounded, got ${entries.length} rows`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries skips a symlink back to a non-root ancestor", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-nested-cycle-"));
  const selected = path.join(root, "project");
  const nested = path.join(selected, "a", "b");
  await fs.promises.mkdir(nested, { recursive: true });
  await fs.promises.writeFile(path.join(selected, "a", "keep.txt"), "keep");
  try {
    await fs.promises.symlink(
      path.join(selected, "a"),
      path.join(nested, "back"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const entries = await Promise.race([
      collectLocalTreeEntries(selected),
      new Promise((_, reject) => setTimeout(() => reject(new Error("local tree scan followed a nested ancestor symlink cycle")), 500)),
    ]);
    const loopRows = entries.filter((entry) => entry.relativePath.includes("/back/"));
    assert.equal(loopRows.length, 0, "symlink to a non-root ancestor must not duplicate the ancestor subtree");
    assert.equal(
      entries.filter((entry) => entry.relativePath.endsWith("/back")).length,
      0,
      "cyclic directory links must be skipped instead of uploaded as files",
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries counts a cyclic directory alias against the global budget", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-cycle-budget-"));
  const selected = path.join(root, "project");
  const nested = path.join(selected, "nested");
  await fs.promises.mkdir(nested, { recursive: true });
  try {
    await fs.promises.symlink(selected, path.join(nested, "back"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    await assert.rejects(
      collectLocalTreeEntries(selected, { maxDirectories: 2, maxEntries: 10 }),
      /Local directory traversal directory limit exceeded \(2\).*smaller folder/i,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries bounds non-cyclic directory symlink fan-out", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-fanout-"));
  const selected = path.join(root, "project");
  const shared = path.join(root, "shared");
  await fs.promises.mkdir(selected, { recursive: true });
  await fs.promises.mkdir(shared, { recursive: true });
  await fs.promises.writeFile(path.join(shared, "payload.txt"), "payload");
  try {
    for (let index = 0; index < 4; index += 1) {
      await fs.promises.symlink(
        shared,
        path.join(selected, `alias-${index}`),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    await assert.rejects(
      collectLocalTreeEntries(selected, { maxDirectories: 4, maxEntries: 20 }),
      /Local directory traversal directory limit exceeded \(4\).*smaller folder/i,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries accepts exact directory and entry budget boundaries", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-budget-edge-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(path.join(selected, "nested"), { recursive: true });
  await fs.promises.writeFile(path.join(selected, "one.txt"), "1");
  await fs.promises.writeFile(path.join(selected, "nested", "two.txt"), "2");
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const entries = await collectLocalTreeEntries(selected, {
    maxDirectories: 2,
    maxEntries: 3,
  });
  assert.deepEqual(entries.map((entry) => entry.relativePath), [
    "project",
    "project/nested",
    "project/one.txt",
    "project/nested/two.txt",
  ]);
});

test("collectLocalTreeEntries rejects one entry beyond the global entry budget", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-entry-budget-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(selected, { recursive: true });
  await Promise.all([
    fs.promises.writeFile(path.join(selected, "one.txt"), "1"),
    fs.promises.writeFile(path.join(selected, "two.txt"), "2"),
    fs.promises.writeFile(path.join(selected, "three.txt"), "3"),
  ]);
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    collectLocalTreeEntries(selected, { maxDirectories: 1, maxEntries: 2 }),
    /Local directory traversal entry limit exceeded \(2\).*smaller folder/i,
  );
});

test("collectLocalTreeEntries follows a non-cyclic directory symlink for folder upload", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-directory-link-"));
  const selected = path.join(root, "project");
  const target = path.join(root, "shared-assets");
  const link = path.join(selected, "assets");
  await fs.promises.mkdir(selected, { recursive: true });
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.writeFile(path.join(target, "logo.txt"), "logo");
  try {
    await fs.promises.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const entries = await collectLocalTreeEntries(selected);
    const linkedDirectory = entries.find((entry) => entry.relativePath === "project/assets");
    const linkedFile = entries.find((entry) => entry.relativePath === "project/assets/logo.txt");
    assert.equal(linkedDirectory?.type, "directory");
    assert.equal(linkedFile?.type, "file");
    assert.equal(linkedFile?.localPath, path.join(link, "logo.txt"));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("statLocal follows symlinks and reports target size for resume sizing", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-stat-local-follow-"));
  const target = path.join(root, "outside.bin");
  const link = path.join(root, "tool.sh");
  await fs.promises.writeFile(target, "target-bytes-longer");
  try {
    await fs.promises.symlink(target, link, "file");
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const linkStat = await fs.promises.lstat(link);
    const targetStat = await fs.promises.stat(target);
    assert.notEqual(linkStat.size, targetStat.size, "fixture must distinguish link metadata from target");

    const result = await statLocal(null, { path: link });
    assert.equal(result.type, "file");
    assert.equal(result.size, targetStat.size);
    assert.equal(result.lastModified, targetStat.mtime.getTime());
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("lstatLocal classifies symlinks without following the target", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-lstat-local-link-"));
  const target = path.join(root, "outside.bin");
  const link = path.join(root, "tool.sh");
  await fs.promises.writeFile(target, "target-bytes-longer");
  try {
    await fs.promises.symlink(target, link, "file");
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const linkStat = await fs.promises.lstat(link);
    const targetStat = await fs.promises.stat(target);
    assert.notEqual(linkStat.size, targetStat.size, "fixture must distinguish link metadata from target");

    const result = await lstatLocal(null, { path: link });
    assert.equal(result.type, "symlink");
    assert.equal(result.size, linkStat.size);
    assert.equal(result.lastModified, linkStat.mtime.getTime());
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("collectLocalTreeEntries skips realpath for ordinary files and directories", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-realpath-"));
  const selected = path.join(root, "project");
  await fs.promises.mkdir(path.join(selected, "src"), { recursive: true });
  await fs.promises.writeFile(path.join(selected, "src", "index.txt"), "ok");

  const originalRealpath = fs.promises.realpath;
  let realpathCalls = 0;
  fs.promises.realpath = async (...args) => {
    realpathCalls += 1;
    return originalRealpath.apply(fs.promises, args);
  };
  t.after(async () => {
    fs.promises.realpath = originalRealpath;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const entries = await collectLocalTreeEntries(selected);
  assert.equal(entries.some((entry) => entry.relativePath === "project/src/index.txt"), true);
  assert.equal(realpathCalls, 1, "only the selected root should be realpath'd");
});

test("collectLocalTreeEntries uses the target metadata for a leaf file symlink", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-upload-tree-file-link-"));
  const selected = path.join(root, "project");
  const target = path.join(root, "target.bin");
  const link = path.join(selected, "linked.bin");
  await fs.promises.mkdir(selected, { recursive: true });
  await fs.promises.writeFile(target, "target-file-contents");
  try {
    await fs.promises.symlink(target, link, "file");
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const targetStat = await fs.promises.stat(target);
    const linkStat = await fs.promises.lstat(link);
    assert.notEqual(linkStat.size, targetStat.size, "fixture must distinguish link metadata from target metadata");

    const entries = await collectLocalTreeEntries(selected);
    const linked = entries.find((entry) => entry.relativePath === "project/linked.bin");
    assert.equal(linked?.type, "file");
    assert.equal(linked?.size, targetStat.size);
    assert.equal(linked?.lastModified, targetStat.mtime.getTime());
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("readLocalFile returns only the trailing maxBytes when requested", async () => {
  const { readLocalFile } = require("./localFsBridge.cjs");
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-local-read-"));
  const filePath = path.join(root, "hist.txt");
  const body = "AAAA\nBBBB\nCCCC\nDDDD\n";
  await fs.promises.writeFile(filePath, body);

  try {
    const full = await readLocalFile(null, { path: filePath });
    assert.equal(Buffer.from(full).toString("utf8"), body);

    const tailed = await readLocalFile(null, { path: filePath, maxBytes: 10 });
    assert.equal(Buffer.from(tailed).toString("utf8"), body.slice(-10));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
