const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");

const script = path.resolve(__dirname, "fetch-et-binaries.cjs");
const execFileAsync = promisify(execFile);
const {
  parseEtBinRepository,
  replaceDir,
  resolveHostTarget,
  resolveTarArchiveInvocation,
} = require("./fetch-et-binaries.cjs");

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-fetch-et-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeTarGz(t, entries) {
  const dir = makeTmp(t);
  for (const [name, contents] of Object.entries(entries)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  // Use cwd + a relative archive name so GNU tar (Git Bash on Windows) does
  // not treat a "C:" drive prefix in the archive path as a remote host.
  const outDir = makeTmp(t);
  execFileSync("tar", ["-czf", "bundle.tar.gz", "-C", dir, "."], { cwd: outDir, stdio: "pipe" });
  return fs.readFileSync(path.join(outDir, "bundle.tar.gz"));
}

async function serveAssets(t, assets) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("/").pop());
    if (!Object.prototype.hasOwnProperty.call(assets, name)) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200);
    res.end(assets[name]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("fetch-et-binaries defaults to the dedicated et binary repository", () => {
  assert.deepEqual(parseEtBinRepository({}), { owner: "binaricat", repo: "Netcatty-et-bin" });
  assert.deepEqual(parseEtBinRepository({ GITHUB_REPOSITORY: "owner/project" }), {
    owner: "owner",
    repo: "Netcatty-et-bin",
  });
  assert.deepEqual(
    parseEtBinRepository({ GITHUB_REPOSITORY: "owner/project", ET_BIN_OWNER: "bin", ET_BIN_REPO: "binaries" }),
    { owner: "bin", repo: "binaries" },
  );
});

test("resolveHostTarget maps the local platform to the bundled target", () => {
  assert.deepEqual(resolveHostTarget({ platform: "darwin", arch: "arm64" }), { platform: "darwin", arch: "universal" });
  assert.deepEqual(resolveHostTarget({ platform: "darwin", arch: "x64" }), { platform: "darwin", arch: "universal" });
  assert.deepEqual(resolveHostTarget({ platform: "linux", arch: "x64" }), { platform: "linux", arch: "x64" });
  assert.deepEqual(resolveHostTarget({ platform: "linux", arch: "arm64" }), { platform: "linux", arch: "arm64" });
  assert.deepEqual(resolveHostTarget({ platform: "win32", arch: "x64" }), { platform: "win32", arch: "x64" });
  assert.throws(() => resolveHostTarget({ platform: "freebsd", arch: "x64" }), /No bundled et target/);
});

test("tar archive invocation uses a relative archive name for Windows paths", () => {
  assert.deepEqual(
    resolveTarArchiveInvocation(
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\netcatty-et-abc\\bundle.tar.gz",
      "win32",
    ),
    {
      cwd: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\netcatty-et-abc",
      archive: "bundle.tar.gz",
    },
  );
});

test("replaceDir falls back to copy when rename crosses devices", (t) => {
  const root = makeTmp(t);
  const src = path.join(root, "src");
  const dest = path.join(root, "dest");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "et.exe"), "exe");

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (from === src && to === dest) {
      const error = new Error("cross-device link not permitted");
      error.code = "EXDEV";
      throw error;
    }
    return originalRenameSync(from, to);
  };
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  replaceDir(src, dest);

  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(path.join(dest, "et.exe"), "utf8"), "exe");
});

test("fetch-et-binaries host mode skips unsupported local targets", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const baseUrl = await serveAssets(t, { SHA256SUMS: "" });

  const { stderr } = await execFileAsync(
    process.execPath,
    [script, "--host", "--platform=win32", "--arch=arm64"],
    {
      env: {
        ...process.env,
        ET_BIN_RELEASE: "test",
        ET_BIN_BASE_URL: baseUrl,
        ET_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    },
  );

  assert.match(stderr, /No bundled et target for win32-arm64/);
  assert.equal(fs.existsSync(resDir), false);
});

test("fetch-et-binaries skips when ET_BIN_RELEASE is unset", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const { stdout } = await execFileAsync(process.execPath, [script], {
    env: { ...process.env, ET_BIN_RELEASE: "", ET_BIN_RES_DIR: resDir, CI: "true" },
    stdio: "pipe",
  });
  assert.match(stdout, /ET_BIN_RELEASE is unset/);
  assert.equal(fs.existsSync(resDir), false);
});

test("fetch-et-binaries unpacks the Linux tarball", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const tar = makeTarGz(t, { et: "binary" });
  const baseUrl = await serveAssets(t, {
    "et-linux-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  et-linux-x64.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=linux", "--arch=x64"], {
    env: { ...process.env, ET_BIN_RELEASE: "test", ET_BIN_BASE_URL: baseUrl, ET_BIN_RES_DIR: resDir, CI: "true" },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(resDir, "linux-x64", "et")), true);
  assert.equal(fs.readFileSync(path.join(resDir, "linux-x64", "et"), "utf8"), "binary");
});

test("fetch-et-binaries unpacks the Darwin universal tarball", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const tar = makeTarGz(t, { et: "binary" });
  const baseUrl = await serveAssets(t, {
    "et-darwin-universal.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  et-darwin-universal.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=darwin", "--arch=universal"], {
    env: { ...process.env, ET_BIN_RELEASE: "test", ET_BIN_BASE_URL: baseUrl, ET_BIN_RES_DIR: resDir, CI: "true" },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(resDir, "darwin-universal", "et")), true);
});

test("fetch-et-binaries normalizes a static Windows tarball with no DLLs", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const tar = makeTarGz(t, { "et.exe": "exe" });
  const baseUrl = await serveAssets(t, {
    "et-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  et-win32-x64.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
    env: { ...process.env, ET_BIN_RELEASE: "test", ET_BIN_BASE_URL: baseUrl, ET_BIN_RES_DIR: resDir, CI: "true" },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "et.exe")), true);
});

test("fetch-et-binaries packages an optional Windows DLL directory when present", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const tar = makeTarGz(t, { "et.exe": "exe", "et-win32-x64-dlls/vcruntime140.dll": "dll" });
  const baseUrl = await serveAssets(t, {
    "et-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  et-win32-x64.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
    env: { ...process.env, ET_BIN_RELEASE: "test", ET_BIN_BASE_URL: baseUrl, ET_BIN_RES_DIR: resDir, CI: "true" },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "et.exe")), true);
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "et-win32-x64-dlls", "vcruntime140.dll")), true);
});

test("fetch-et-binaries rejects a tarball without et", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const tar = makeTarGz(t, { "readme.txt": "nope" });
  const baseUrl = await serveAssets(t, {
    "et-linux-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  et-linux-x64.tar.gz\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=linux", "--arch=x64"], {
      env: { ...process.env, ET_BIN_RELEASE: "test", ET_BIN_BASE_URL: baseUrl, ET_BIN_RES_DIR: resDir, CI: "true" },
      stdio: "pipe",
    }),
    /did not contain et/,
  );
});

test("fetch-et-binaries fails when SHA256SUMS lacks the requested asset", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "et");
  const tar = makeTarGz(t, { et: "binary" });
  const baseUrl = await serveAssets(t, {
    "et-linux-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(Buffer.from("other"))}  other-file\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=linux", "--arch=x64"], {
      env: { ...process.env, ET_BIN_RELEASE: "test", ET_BIN_BASE_URL: baseUrl, ET_BIN_RES_DIR: resDir, CI: "true" },
      stdio: "pipe",
    }),
    /no SHA256 entry/,
  );
});

test("fetch-et-binaries rejects symlinks inside tarballs", { skip: process.platform === "win32" }, async (t) => {
  const srcDir = makeTmp(t);
  fs.writeFileSync(path.join(srcDir, "outside"), "outside");
  fs.symlinkSync(path.join(srcDir, "outside"), path.join(srcDir, "et"));
  const outDir = makeTmp(t);
  execFileSync("tar", ["-czf", "symlink.tar.gz", "-C", srcDir, "et"], { cwd: outDir, stdio: "pipe" });
  const tar = fs.readFileSync(path.join(outDir, "symlink.tar.gz"));
  const baseUrl = await serveAssets(t, {
    "et-linux-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  et-linux-x64.tar.gz\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=linux", "--arch=x64"], {
      env: {
        ...process.env,
        ET_BIN_RELEASE: "test",
        ET_BIN_BASE_URL: baseUrl,
        ET_BIN_RES_DIR: path.join(makeTmp(t), "resources", "et"),
        CI: "true",
      },
      stdio: "pipe",
    }),
    /symbolic link|did not contain et/,
  );
});
