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
const targets = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    from: "i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
    to: "(i||r)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    from: "r?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
    to: "(r||o)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
  },
];

const makeTmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-sync-patch-"));
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
    assert.equal(source.includes(`${target.to}${marker}`), true);
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

test("fails closed when a target is missing or ambiguous", async (t) => {
  const root = makeTmp(t);
  writeBuild(root, targets[0], `${targets[0].from} ${targets[0].from}`);
  writeBuild(root, targets[1], "unknown xterm build");

  await assert.rejects(execFileAsync(process.execPath, [script], { cwd: root }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /patched=0 already=0 upstream=0 missing=2/);
    assert.match(error.stderr, /sync-render ternary not found \(or ambiguous\)/);
    return true;
  });
});
