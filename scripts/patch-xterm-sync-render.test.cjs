"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, "patch-xterm-sync-render.cjs");
const marker = "/*netcatty:sync-render*/";
const version = "6.1.0-beta.220";
const targets = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    from: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
    to: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),(i||r)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    from: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),r?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
    to: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),(r||o)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
  },
];

const makeTmp = (t, packageVersion = version) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-sync-patch-"));
  const packageFile = path.join(dir, "node_modules/@xterm/xterm/package.json");
  fs.mkdirSync(path.dirname(packageFile), { recursive: true });
  fs.writeFileSync(packageFile, JSON.stringify({ version: packageVersion }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const writeBuild = (root, target, source = target.from) => {
  const file = path.join(root, target.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `prefix ${source} suffix`);
};

test("patches both xterm builds and is idempotent", async (t) => {
  const root = makeTmp(t);
  for (const target of targets) writeBuild(root, target);

  const first = await execFileAsync(process.execPath, [script], { cwd: root });
  assert.match(first.stdout, /patched=2 already=0 upstream=0 missing=0/);
  assert.equal(first.stderr, "");
  for (const target of targets) {
    const source = fs.readFileSync(path.join(root, target.file), "utf8");
    assert.equal(source.includes(target.from), false);
    assert.equal(source.includes(`${target.to.slice(0, -1)}${marker}}`), true);
  }

  const afterFirstRun = targets.map((target) =>
    fs.readFileSync(path.join(root, target.file), "utf8")
  );
  const second = await execFileAsync(process.execPath, [script], { cwd: root });
  assert.match(second.stdout, /patched=0 already=2 upstream=0 missing=0/);
  assert.deepEqual(
    targets.map((target) => fs.readFileSync(path.join(root, target.file), "utf8")),
    afterFirstRun,
  );
});

test("leaves the exact upstream fix untouched", async (t) => {
  const root = makeTmp(t);
  for (const target of targets) writeBuild(root, target, target.to);

  const result = await execFileAsync(process.execPath, [script], { cwd: root });
  assert.match(result.stdout, /patched=0 already=0 upstream=2 missing=0/);
  for (const target of targets) {
    const source = fs.readFileSync(path.join(root, target.file), "utf8");
    assert.equal(source.includes(target.to), true);
    assert.equal(source.includes(marker), false);
  }
});

test("validates every build before changing either one", async (t) => {
  const root = makeTmp(t);
  writeBuild(root, targets[0]);
  writeBuild(root, targets[1], "unknown xterm build");
  const original = fs.readFileSync(path.join(root, targets[0].file), "utf8");

  await assert.rejects(execFileAsync(process.execPath, [script], { cwd: root }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /patched=0 already=0 upstream=0 missing=1/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, targets[0].file), "utf8"), original);
});

test("rejects ambiguous, out-of-context, and unexpected-version builds", async (t) => {
  const cases = [
    { version, cjs: `${targets[0].from} ${targets[0].from}`, esm: targets[1].from },
    { version, cjs: "i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)", esm: targets[1].from },
    { version: "6.1.0-beta.221", cjs: targets[0].from, esm: targets[1].from },
  ];

  for (const entry of cases) {
    const root = makeTmp(t, entry.version);
    writeBuild(root, targets[0], entry.cjs);
    writeBuild(root, targets[1], entry.esm);
    await assert.rejects(execFileAsync(process.execPath, [script], { cwd: root }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /patched=0/);
      return true;
    });
  }
});
