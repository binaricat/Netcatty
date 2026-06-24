/* global __dirname, process */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, "patch-xterm-webgl-atlas.cjs");
const marker = "/*netcatty:#1063 atlas-isolation*/";

const webglBeta219MjsLoop =
  "for(let u=0;u<J.length;u++){let p=J[u];if(Ee(p.config,h))return p.ownedBy.push(i),p.atlas}";
const webglBeta219CjsLoop =
  "for(let e=0;e<a.length;e++){const i=a[e];if((0,r.configEquals)(i.config,c))return i.ownedBy.push(t),i.atlas}";

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-webgl-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeWebglBuild(root, file, loop) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `prefix ${loop} suffix`);
}

test("patches @xterm/addon-webgl 0.20 beta atlas sharing loops", async (t) => {
  const root = makeTmp(t);
  const mjs = "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";
  const cjs = "node_modules/@xterm/addon-webgl/lib/addon-webgl.js";
  writeWebglBuild(root, mjs, webglBeta219MjsLoop);
  writeWebglBuild(root, cjs, webglBeta219CjsLoop);

  const { stdout, stderr } = await execFileAsync(process.execPath, [script], { cwd: root });

  assert.match(stdout, /patched=2/);
  assert.equal(stderr, "");
  assert.match(fs.readFileSync(path.join(root, mjs), "utf8"), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(fs.readFileSync(path.join(root, cjs), "utf8"), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
