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

test("fetch-mosh-binaries normalizes the Windows tarball to mosh-client.exe", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client-win32-x64.exe": "exe",
    "mosh-client-win32-x64-dlls/cygwin1.dll": "dll",
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
});

test("fetch-mosh-binaries fails when SHA256SUMS lacks the requested asset", async (t) => {
  const resDir = path.join(makeTmp(t), "resources", "mosh");
  const tar = makeTarGz(t, {
    "mosh-client.exe": "exe",
    "mosh-client-win32-x64-dlls/cygwin1.dll": "dll",
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
