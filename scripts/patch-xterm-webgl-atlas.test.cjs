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
const atlasMarker = "/*netcatty:#1063 atlas-isolation*/";
const mipmapMarker = "/*netcatty:#2158 no-atlas-mipmaps*/";

const webglBeta219MjsLoop =
  "for(let u=0;u<J.length;u++){let p=J[u];if(Ee(p.config,h))return p.ownedBy.push(i),p.atlas}";
const webglBeta219CjsLoop =
  "for(let e=0;e<a.length;e++){const i=a[e];if((0,r.configEquals)(i.config,c))return i.ownedBy.push(t),i.atlas}";
const webgl019MjsLoop =
  "for(let h=0;h<le.length;h++){let f=le[h];if(Mi(f.config,u))return f.ownedBy.push(i),f.atlas}";
const webgl019CjsLoop =
  "for(let t=0;t<r.length;t++){const i=r[t];if((0,n.configEquals)(i.config,d))return i.ownedBy.push(e),i.atlas}";

function filterSequence(gl) {
  return (
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_MIN_FILTER,${gl}.LINEAR),` +
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_MAG_FILTER,${gl}.LINEAR)`
  );
}

function mipmapPath(gl, pages, index) {
  return (
    `${gl}.texImage2D(${gl}.TEXTURE_2D,0,${gl}.RGBA,${gl}.RGBA,${gl}.UNSIGNED_BYTE,${pages}.pages[${index}].canvas),` +
    `${gl}.generateMipmap(${gl}.TEXTURE_2D),` +
    `this._atlasTextures[${index}].version=${pages}.pages[${index}].version`
  );
}

function upstreamFixedPath(gl, pages, index) {
  return (
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_WRAP_T,${gl}.CLAMP_TO_EDGE),` +
    `${filterSequence(gl)},` +
    `${gl}.texImage2D(${gl}.TEXTURE_2D,0,${gl}.RGBA,${gl}.RGBA,${gl}.UNSIGNED_BYTE,${pages}.pages[${index}].canvas),` +
    `this._atlasTextures[${index}].version=${pages}.pages[${index}].version`
  );
}

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-webgl-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeWebglBuild(root, file, loop, glyphAtlasPath) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `prefix ${loop} middle ${glyphAtlasPath} suffix`);
}

test("patches @xterm/addon-webgl 0.20 beta atlas corruption paths", async (t) => {
  const root = makeTmp(t);
  const mjs = "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";
  const cjs = "node_modules/@xterm/addon-webgl/lib/addon-webgl.js";
  writeWebglBuild(root, mjs, webglBeta219MjsLoop, mipmapPath("t", "r", "n"));
  writeWebglBuild(root, cjs, webglBeta219CjsLoop, mipmapPath("t", "e", "i"));

  const { stdout, stderr } = await execFileAsync(process.execPath, [script], { cwd: root });

  assert.match(stdout, /atlas: patched=2/);
  assert.match(stdout, /mipmap: patched=2/);
  assert.equal(stderr, "");
  for (const file of [mjs, cjs]) {
    const patched = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(patched, new RegExp(atlasMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(patched, new RegExp(mipmapMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(patched, /generateMipmap/);
    assert.match(patched, /TEXTURE_MIN_FILTER/);
    assert.match(patched, /TEXTURE_MAG_FILTER/);
  }

  const afterFirstRun = [mjs, cjs].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const rerun = await execFileAsync(process.execPath, [script], { cwd: root });
  assert.match(rerun.stdout, /atlas: patched=0 already=2/);
  assert.match(rerun.stdout, /mipmap: patched=0 already=2/);
  assert.deepEqual(
    [mjs, cjs].map((file) => fs.readFileSync(path.join(root, file), "utf8")),
    afterFirstRun,
  );
});

test("patches the real @xterm/addon-webgl 0.19 atlas paths", async (t) => {
  const root = makeTmp(t);
  const mjs = "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";
  const cjs = "node_modules/@xterm/addon-webgl/lib/addon-webgl.js";
  writeWebglBuild(root, mjs, webgl019MjsLoop, mipmapPath("t", "n", "s"));
  writeWebglBuild(root, cjs, webgl019CjsLoop, mipmapPath("e", "t", "i"));

  const { stdout } = await execFileAsync(process.execPath, [script], { cwd: root });

  assert.match(stdout, /atlas: patched=2/);
  assert.match(stdout, /mipmap: patched=2/);
  for (const file of [mjs, cjs]) {
    const patched = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(patched, new RegExp(mipmapMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(patched, /generateMipmap/);
  }
});

test("accepts the scoped upstream xterm fix", async (t) => {
  const root = makeTmp(t);
  writeWebglBuild(
    root,
    "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs",
    webglBeta219MjsLoop,
    upstreamFixedPath("t", "r", "s"),
  );
  writeWebglBuild(
    root,
    "node_modules/@xterm/addon-webgl/lib/addon-webgl.js",
    webglBeta219CjsLoop,
    upstreamFixedPath("t", "e", "i"),
  );

  const { stdout } = await execFileAsync(process.execPath, [script], { cwd: root });

  assert.match(stdout, /mipmap: patched=0 already=0 upstream=2 missing=0/);
});

test("fails closed when multiple glyph-atlas mipmap paths are present", async (t) => {
  const root = makeTmp(t);
  const mjsPath = mipmapPath("t", "r", "n");
  const cjsPath = mipmapPath("t", "e", "i");
  writeWebglBuild(root, "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs", webglBeta219MjsLoop, `${mjsPath} ${mjsPath}`);
  writeWebglBuild(root, "node_modules/@xterm/addon-webgl/lib/addon-webgl.js", webglBeta219CjsLoop, `${cjsPath} ${cjsPath}`);

  await assert.rejects(execFileAsync(process.execPath, [script], { cwd: root }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /mipmap path is missing or ambiguous/);
    return true;
  });
});

test("fails closed when unrelated filters accompany an unknown atlas path", async (t) => {
  const root = makeTmp(t);
  const misleadingUnknownPath =
    `${filterSequence("t")} unrelated ` + mipmapPath("g", "pages", "i");
  writeWebglBuild(
    root,
    "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs",
    webglBeta219MjsLoop,
    misleadingUnknownPath,
  );
  writeWebglBuild(
    root,
    "node_modules/@xterm/addon-webgl/lib/addon-webgl.js",
    webglBeta219CjsLoop,
    misleadingUnknownPath,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [script], { cwd: root }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /glyph-atlas mipmap path is missing or ambiguous/);
      return true;
    },
  );
});
