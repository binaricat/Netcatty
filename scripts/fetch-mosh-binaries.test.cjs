const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");

const script = path.resolve(__dirname, "fetch-mosh-binaries.cjs");
const execFileAsync = promisify(execFile);
const {
  parseMoshBinRepository,
  replaceDir,
  resolveHostTarget,
  resolveTarArchiveInvocation,
} = require("./fetch-mosh-binaries.cjs");

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-fetch-mosh-"));
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
  const tarPath = path.join(makeTmp(t), "bundle.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", dir, "."], { stdio: "pipe" });
  return fs.readFileSync(tarPath);
}

test("fetch-mosh-binaries defaults to the dedicated mosh binary repository", () => {
  assert.deepEqual(parseMoshBinRepository({}), { owner: "binaricat", repo: "Netcatty-mosh-bin" });
  assert.deepEqual(parseMoshBinRepository({ GITHUB_REPOSITORY: "owner/project" }), {
    owner: "owner",
    repo: "Netcatty-mosh-bin",
  });
  assert.deepEqual(
    parseMoshBinRepository({ GITHUB_REPOSITORY: "owner/project", MOSH_BIN_OWNER: "bin", MOSH_BIN_REPO: "binaries" }),
    { owner: "bin", repo: "binaries" },
  );
});

test("resolveHostTarget maps the local platform to the bundled target", () => {
  assert.deepEqual(resolveHostTarget({ platform: "darwin", arch: "arm64" }), {
    platform: "darwin",
    arch: "universal",
  });
  assert.deepEqual(resolveHostTarget({ platform: "darwin", arch: "x64" }), {
    platform: "darwin",
    arch: "universal",
  });
  assert.deepEqual(resolveHostTarget({ platform: "linux", arch: "x64" }), {
    platform: "linux",
    arch: "x64",
  });
  assert.deepEqual(resolveHostTarget({ platform: "linux", arch: "arm64" }), {
    platform: "linux",
    arch: "arm64",
  });
  assert.deepEqual(resolveHostTarget({ platform: "win32", arch: "x64" }), {
    platform: "win32",
    arch: "x64",
  });
  assert.throws(() => resolveHostTarget({ platform: "freebsd", arch: "x64" }), /No bundled mosh-client target/);
});

test("tar archive invocation uses a relative archive name for Windows paths", () => {
  assert.deepEqual(
    resolveTarArchiveInvocation(
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\netcatty-mosh-abc\\bundle.tar.gz",
      "win32",
    ),
    {
      cwd: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\netcatty-mosh-abc",
      archive: "bundle.tar.gz",
    },
  );
});

test("replaceDir falls back to copy when rename crosses devices", (t) => {
  const root = makeTmp(t);
  const src = path.join(root, "src");
  const dest = path.join(root, "dest");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "mosh-client.exe"), "exe");

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
  assert.equal(fs.readFileSync(path.join(dest, "mosh-client.exe"), "utf8"), "exe");
});

test("fetch-mosh-binaries host mode skips unsupported local targets", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const baseUrl = await serveAssets(t, {
    SHA256SUMS: "",
  });

  const { stderr } = await execFileAsync(
    process.execPath,
    [script, "--host", "--platform=win32", "--arch=arm64"],
    {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "test",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    },
  );

  assert.match(stderr, /No bundled mosh-client target for win32-arm64/);
  assert.equal(fs.existsSync(resDir), false);
});

test("fetch-mosh-binaries host mode skips unsupported targets before resolving release", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [script, "--host", "--resolve-release", "--platform=win32", "--arch=arm64"],
    {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "",
        MOSH_BIN_RELEASES_JSON: "[]",
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    },
  );

  assert.match(stderr, /No bundled mosh-client target for win32-arm64/);
  assert.doesNotMatch(stdout, /MOSH_BIN_RELEASE is unset/);
  assert.equal(fs.existsSync(resDir), false);
});

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

test("fetch-mosh-binaries normalizes the Windows tarball to mosh-client.exe", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client-win32-x64.exe": "exe",
    "mosh-client-win32-x64-dlls/cygwin1.dll": "dll",
    "terminfo/x/xterm-256color": "terminfo",
  });
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-win32-x64.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
    env: {
      ...process.env,
      MOSH_BIN_RELEASE: "test",
      MOSH_BIN_BASE_URL: baseUrl,
      MOSH_BIN_RES_DIR: resDir,
      CI: "true",
    },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "mosh-client.exe")), true);
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "mosh-client-win32-x64-dlls", "cygwin1.dll")), true);
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "terminfo", "x", "xterm-256color")), true);
});

test("fetch-mosh-binaries accepts legacy Windows bundles without terminfo", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client.exe": "exe",
    "mosh-client-win32-x64-dlls/cygwin1.dll": "dll",
  });
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-win32-x64.tar.gz\n`,
  });

  const { stderr } = await execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
    env: {
      ...process.env,
      MOSH_BIN_RELEASE: "test",
      MOSH_BIN_BASE_URL: baseUrl,
      MOSH_BIN_RES_DIR: resDir,
      CI: "true",
    },
    stdio: "pipe",
  });

  assert.match(stderr, /did not contain terminfo for xterm-256color/);
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "mosh-client.exe")), true);
});

test("fetch-mosh-binaries rejects invalid Windows terminfo entries", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const srcDir = makeTmp(t);
  fs.writeFileSync(path.join(srcDir, "mosh-client.exe"), "exe");
  fs.mkdirSync(path.join(srcDir, "mosh-client-win32-x64-dlls"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "mosh-client-win32-x64-dlls", "cygwin1.dll"), "dll");
  fs.mkdirSync(path.join(srcDir, "terminfo", "x", "xterm-256color"), { recursive: true });
  const tarPath = path.join(makeTmp(t), "invalid-terminfo.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", srcDir, "mosh-client.exe", "mosh-client-win32-x64-dlls", "terminfo"], { stdio: "pipe" });
  const tar = fs.readFileSync(tarPath);
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-win32-x64.tar.gz\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "test",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    }),
    /invalid terminfo for xterm-256color/,
  );
});

test("fetch-mosh-binaries fails when SHA256SUMS lacks the requested asset", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client.exe": "exe",
    "mosh-client-win32-x64-dlls/cygwin1.dll": "dll",
    "terminfo/x/xterm-256color": "terminfo",
  });
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(Buffer.from("other"))}  other-file\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "test",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    }),
  );
});

test("fetch-mosh-binaries rejects symlinks inside Windows tarballs", { skip: process.platform === "win32" }, async (t) => {
  const srcDir = makeTmp(t);
  fs.writeFileSync(path.join(srcDir, "outside.exe"), "outside");
  fs.symlinkSync(path.join(srcDir, "outside.exe"), path.join(srcDir, "mosh-client.exe"));
  fs.mkdirSync(path.join(srcDir, "mosh-client-win32-x64-dlls"));
  fs.writeFileSync(path.join(srcDir, "mosh-client-win32-x64-dlls", "cygwin1.dll"), "dll");
  const tarPath = path.join(makeTmp(t), "symlink.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", srcDir, "mosh-client.exe", "mosh-client-win32-x64-dlls"], { stdio: "pipe" });
  const tar = fs.readFileSync(tarPath);
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-win32-x64.tar.gz\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "test",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: path.join(makeTmp(t), "resources", "mosh"),
        CI: "true",
      },
      stdio: "pipe",
    }),
    /symbolic link|did not contain mosh-client\.exe/,
  );
});
