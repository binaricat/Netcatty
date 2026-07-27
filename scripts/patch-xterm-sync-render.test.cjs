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
const version = "6.1.0-beta.220";
const markers = [
  "/*netcatty:sync-render*/",
  "/*netcatty:sync-render-listener*/",
  "/*netcatty:sync-render-close*/",
];
const targets = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    edits: [
      {
        from: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
        to: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),(i||r)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
      },
      {
        from: "this._register(this._inputHandler.onRequestRefreshRows(e=>this.refresh(e?.start??0,e?.end??this.rows-1)))",
        to: "this._register(this._inputHandler.onRequestRefreshRows(e=>this.refresh(e?.start??0,e?.end??this.rows-1,e?.sync??!1)))",
      },
      {
        from: "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire(void 0);break",
        to: "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire({sync:!0});break",
      },
    ],
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    edits: [
      {
        from: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),r?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
        to: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),(r||o)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
      },
      {
        from: "this._register(this._inputHandler.onRequestRefreshRows(t=>this.refresh(t?.start??0,t?.end??this.rows-1)))",
        to: "this._register(this._inputHandler.onRequestRefreshRows(t=>this.refresh(t?.start??0,t?.end??this.rows-1,t?.sync??!1)))",
      },
      {
        from: "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire(void 0);break",
        to: "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire({sync:!0});break",
      },
    ],
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

const sourceFor = (target, state) => target.edits
  .map((edit, index) => state === "from" ? edit.from : `${edit.to}${markers[index]}`)
  .join(" separator ");

const writeBuild = (root, target, source = sourceFor(target, "from")) => {
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
  const afterFirstRun = targets.map((target) =>
    fs.readFileSync(path.join(root, target.file), "utf8")
  );
  for (const source of afterFirstRun) {
    for (const marker of markers) assert.equal(source.includes(marker), true);
  }

  const second = await execFileAsync(process.execPath, [script], { cwd: root });
  assert.match(second.stdout, /patched=0 already=2 upstream=0 missing=0/);
  assert.deepEqual(
    targets.map((target) => fs.readFileSync(path.join(root, target.file), "utf8")),
    afterFirstRun,
  );
});

test("leaves the complete upstream-equivalent fix untouched", async (t) => {
  const root = makeTmp(t);
  for (const target of targets) {
    writeBuild(root, target, target.edits.map((edit) => edit.to).join(" separator "));
  }
  const result = await execFileAsync(process.execPath, [script], { cwd: root });
  assert.match(result.stdout, /patched=0 already=0 upstream=2 missing=0/);
  for (const target of targets) {
    const source = fs.readFileSync(path.join(root, target.file), "utf8");
    for (const marker of markers) assert.equal(source.includes(marker), false);
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

test("rejects partial, ambiguous, and unexpected-version builds", async (t) => {
  const cases = [
    {
      version,
      cjs: `${sourceFor(targets[0], "from")} ${targets[0].edits[0].from}`,
      esm: sourceFor(targets[1], "from"),
    },
    {
      version,
      cjs: targets[0].edits.map((edit, index) => index === 0 ? edit.to : edit.from).join(" separator "),
      esm: sourceFor(targets[1], "from"),
    },
    {
      version: "6.1.0-beta.221",
      cjs: sourceFor(targets[0], "from"),
      esm: sourceFor(targets[1], "from"),
    },
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
