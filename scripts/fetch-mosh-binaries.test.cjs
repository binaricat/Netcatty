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
  TARGETS,
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

test("fetch-mosh-binaries defaults to the MoshCatty binary repository", () => {
  assert.deepEqual(parseMoshBinRepository({}), { owner: "binaricat", repo: "MoshCatty" });
  // Fork CI must not inherit GITHUB_REPOSITORY owner for MoshCatty downloads.
  assert.deepEqual(parseMoshBinRepository({ GITHUB_REPOSITORY: "owner/project" }), {
    owner: "binaricat",
    repo: "MoshCatty",
  });
  assert.deepEqual(
    parseMoshBinRepository({ MOSH_BIN_OWNER: "other", MOSH_BIN_REPO: "fork-mosh" }),
    { owner: "other", repo: "fork-mosh" },
  );
});

test("TARGETS are pure MoshCatty tarball assets only", () => {
  for (const t of TARGETS) {
    assert.match(t.file, /^mosh-client-.+\.tar\.gz$/);
    assert.ok(t.binary === "mosh-client" || t.binary === "mosh-client.exe");
    assert.equal(Object.prototype.hasOwnProperty.call(t, "legacy"), false);
  }
});

test("resolveHostTarget maps the local platform to the bundled target", () => {
  assert.deepEqual(resolveHostTarget({ platform: "darwin", arch: "arm64" }), {
    platform: "darwin",
    arch: "universal",
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
  const baseUrl = await serveAssets(t, { SHA256SUMS: "" });

  const { stderr } = await execFileAsync(
    process.execPath,
    [script, "--host", "--platform=win32", "--arch=arm64"],
    {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "moshcatty-0.1.4",
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

test("fetch-mosh-binaries rejects MoshCatty releases before 0.1.4", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "moshcatty-0.1.3",
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    }),
    /below minimum moshcatty-0\.1\.4/,
  );
  assert.equal(fs.existsSync(resDir), false);
});

test("fetch-mosh-binaries unpacks pure Windows MoshCatty tarball", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client.exe": "pure-moshcatty-exe",
  });
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-win32-x64.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
    env: {
      ...process.env,
      MOSH_BIN_RELEASE: "moshcatty-0.1.4",
      MOSH_BIN_BASE_URL: baseUrl,
      MOSH_BIN_RES_DIR: resDir,
      CI: "true",
    },
    stdio: "pipe",
  });

  assert.equal(
    fs.readFileSync(path.join(resDir, "win32-x64", "mosh-client.exe"), "utf8"),
    "pure-moshcatty-exe",
  );
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "mosh-client-win32-x64-dlls")), false);
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "terminfo")), false);
});

test("fetch-mosh-binaries strips accidental dll/terminfo from Windows tarball", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client.exe": "exe",
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
      MOSH_BIN_RELEASE: "moshcatty-0.1.4",
      MOSH_BIN_BASE_URL: baseUrl,
      MOSH_BIN_RES_DIR: resDir,
      CI: "true",
    },
    stdio: "pipe",
  });

  assert.equal(fs.readFileSync(path.join(resDir, "win32-x64", "mosh-client.exe"), "utf8"), "exe");
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "mosh-client-win32-x64-dlls")), false);
  assert.equal(fs.existsSync(path.join(resDir, "win32-x64", "terminfo")), false);
});

test("fetch-mosh-binaries unpacks pure Linux MoshCatty tarball", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client": "linux-client",
  });
  const baseUrl = await serveAssets(t, {
    "mosh-client-linux-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-linux-x64.tar.gz\n`,
  });

  await execFileAsync(process.execPath, [script, "--platform=linux", "--arch=x64"], {
    env: {
      ...process.env,
      MOSH_BIN_RELEASE: "moshcatty-0.1.4",
      MOSH_BIN_BASE_URL: baseUrl,
      MOSH_BIN_RES_DIR: resDir,
      CI: "true",
    },
    stdio: "pipe",
  });

  assert.equal(fs.readFileSync(path.join(resDir, "linux-x64", "mosh-client"), "utf8"), "linux-client");
  assert.equal(fs.existsSync(path.join(resDir, "linux-x64", "terminfo")), false);
});

test("fetch-mosh-binaries rejects tarball without mosh-client", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "README.txt": "no binary here",
  });
  const baseUrl = await serveAssets(t, {
    "mosh-client-linux-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-linux-x64.tar.gz\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=linux", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "moshcatty-0.1.4",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    }),
    /did not contain mosh-client/,
  );
});

test("fetch-mosh-binaries fails when SHA256SUMS lacks the asset", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, { "mosh-client.exe": "exe" });
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(Buffer.from("other"))}  other-file\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "moshcatty-0.1.4",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    }),
    /no SHA256 entry/,
  );
});

test("fetch-mosh-binaries rejects symlinks inside tarballs", { skip: process.platform === "win32" }, async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const srcDir = makeTmp(t);
  fs.writeFileSync(path.join(srcDir, "mosh-client.exe"), "exe");
  fs.symlinkSync("mosh-client.exe", path.join(srcDir, "link.exe"));
  const tarPath = path.join(makeTmp(t), "symlink.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", srcDir, "mosh-client.exe", "link.exe"], { stdio: "pipe" });
  const tar = fs.readFileSync(tarPath);
  const baseUrl = await serveAssets(t, {
    "mosh-client-win32-x64.tar.gz": tar,
    SHA256SUMS: `${sha256(tar)}  mosh-client-win32-x64.tar.gz\n`,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--platform=win32", "--arch=x64"], {
      env: {
        ...process.env,
        MOSH_BIN_RELEASE: "moshcatty-0.1.4",
        MOSH_BIN_BASE_URL: baseUrl,
        MOSH_BIN_RES_DIR: resDir,
        CI: "true",
      },
      stdio: "pipe",
    }),
    /symbolic link/,
  );
});
