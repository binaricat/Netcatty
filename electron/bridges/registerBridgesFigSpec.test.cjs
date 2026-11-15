const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getTempFilePath } = require("./tempDirBridge.cjs");

const {
  filterExcludedFigSpecs,
  isExcludedFigSpec,
  loadFigSpec,
  registerFigSpecHandlers,
} = require("../main/registerBridges.cjs");

function createSpecFixture(t) {
  const root = fs.mkdtempSync(`${getTempFilePath("fig-spec-test")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electronDir = path.join(root, "electron");
  const specDir = path.join(electronDir, "specs");
  const macSpecDir = path.join(specDir, "macos");
  fs.mkdirSync(macSpecDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return { electronDir, specDir, macSpecDir };
}

function createFigHandlers(electronDir) {
  const handlers = new Map();
  registerFigSpecHandlers({ handle: (name, handler) => handlers.set(name, handler) }, electronDir);
  return {
    list: (os) => handlers.get("netcatty:figspec:list")(null, os),
    load: (name, os) => handlers.get("netcatty:figspec:load")(null, name, os),
  };
}

test("filters cloud fig specs removed from packaged builds", () => {
  assert.equal(isExcludedFigSpec("aws"), true);
  assert.equal(isExcludedFigSpec("aws/s3"), true);
  assert.equal(isExcludedFigSpec("gcloud"), true);
  assert.equal(isExcludedFigSpec("gcloud/compute"), true);
  assert.equal(isExcludedFigSpec("az"), true);
  assert.equal(isExcludedFigSpec("az/2.53.0"), true);
  assert.equal(isExcludedFigSpec("aws-vault"), false);

  assert.deepEqual(
    filterExcludedFigSpecs(["git", "aws", "aws/s3", "gcloud", "az/2.53.0", "aws-vault"]),
    ["git", "aws-vault"],
  );
});

test("selects GNU or native macOS specifications for the target session", async () => {
  const electronDir = path.resolve(__dirname, "..");
  const option = (spec, flag) => spec.options.find(({ name }) =>
    (Array.isArray(name) ? name : [name]).includes(flag));

  const [linuxDate, macDate, linuxBase64, macBase64, linuxReadlink, macReadlink] = await Promise.all([
    loadFigSpec(electronDir, "date", "linux"),
    loadFigSpec(electronDir, "date", "macos"),
    loadFigSpec(electronDir, "base64", "linux"),
    loadFigSpec(electronDir, "base64", "macos"),
    loadFigSpec(electronDir, "readlink", "linux"),
    loadFigSpec(electronDir, "readlink", "macos"),
  ]);

  assert.ok(option(linuxDate, "--date"));
  assert.equal(option(linuxDate, "-j"), undefined);
  assert.ok(option(macDate, "-j"));
  assert.ok(option(macDate, "-v"));
  assert.equal(option(macDate, "-d"), undefined);
  assert.equal(option(macDate, "--date"), undefined);
  assert.equal(option(macDate, "-r").args.template, "filepaths");
  assert.equal(option(linuxBase64, "-i").args, undefined);
  assert.equal(option(macBase64, "-i").args.template, "filepaths");
  assert.ok(option(macBase64, "-o"));
  assert.ok(option(linuxReadlink, "--silent"));
  assert.equal(option(macReadlink, "--silent"), undefined);
  assert.equal(option(macReadlink, "-f").args, undefined);
  assert.equal(macReadlink.args.template, "filepaths");
});

test("rejects excluded and invalid specification names", async () => {
  const electronDir = path.resolve(__dirname, "..");
  for (const name of ["../date", "/date", "aws/s3", "gcloud", 42]) {
    assert.equal(await loadFigSpec(electronDir, name, "macos"), null);
  }
});

test("IPC list discovers platform-only specs through renderer hasSpec", async (t) => {
  const { electronDir, specDir, macSpecDir } = createSpecFixture(t);
  const writeSpec = (dir, name) => fs.writeFileSync(
    path.join(dir, `${name}.js`),
    `export default { name: ${JSON.stringify(name)}, options: [] };`,
  );
  writeSpec(specDir, "fixture-root-only");
  writeSpec(macSpecDir, "fixture-macos-only");
  writeSpec(specDir, "fixture-both");
  writeSpec(macSpecDir, "fixture-both");
  writeSpec(specDir, "date");
  writeSpec(macSpecDir, "date");
  writeSpec(specDir, "aws");
  writeSpec(macSpecDir, "gcloud");
  writeSpec(macSpecDir, "az");
  fs.mkdirSync(path.join(specDir, "fixture-directory.js"));
  fs.mkdirSync(path.join(macSpecDir, "fixture-macos-directory.js"));

  const handlers = createFigHandlers(electronDir);
  const list = await handlers.list("macos");
  assert.ok(list.includes("fixture-root-only"));
  assert.ok(list.includes("fixture-macos-only"));
  assert.equal(list.filter((name) => name === "fixture-both").length, 1);
  assert.equal(list.filter((name) => name === "date").length, 1);
  for (const name of ["aws", "gcloud", "az", "fixture-directory", "fixture-macos-directory"]) {
    assert.equal(list.includes(name), false, name);
  }

  // A platform-only command must never be suggested to another session.
  const linuxList = await handlers.list("linux");
  assert.ok(linuxList.includes("fixture-root-only"));
  assert.ok(linuxList.includes("fixture-both"));
  assert.equal(linuxList.includes("fixture-macos-only"), false);
  const unspecifiedList = await handlers.list();
  assert.equal(unspecifiedList.includes("fixture-macos-only"), false);

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { listFigSpecs: handlers.list, loadFigSpec: handlers.load } },
  });
  const rendererModule = path.resolve(__dirname, "../../components/terminal/autocomplete/figSpecLoader.ts");
  const { hasSpec, loadSpec } = await import(pathToFileURL(rendererModule).href);
  assert.equal(await hasSpec("fixture-macos-only", "macos"), true);
  assert.equal(await hasSpec("fixture-macos-only", "linux"), false);
  assert.equal(await hasSpec("fixture-root-only", "linux"), true);
  assert.equal(await loadSpec("fixture-macos-only", "linux"), null);
  assert.equal((await loadSpec("fixture-macos-only", "macos"))?.name, "fixture-macos-only");
  // Loading for macOS must not make the command available to Linux.
  assert.equal(await hasSpec("fixture-macos-only", "linux"), false);
});

test("spec listing keeps symlinked files but ignores directories and dangling links", async (t) => {
  const { electronDir, specDir, macSpecDir } = createSpecFixture(t);
  fs.writeFileSync(path.join(specDir, "fixture-target.js"), 'export default {name: "fixture-target"};');
  fs.mkdirSync(path.join(specDir, "fixture-directory"));
  try {
    fs.symlinkSync(path.join(specDir, "fixture-target.js"), path.join(macSpecDir, "fixture-link.js"), "file");
    fs.symlinkSync(path.join(specDir, "fixture-directory"), path.join(macSpecDir, "fixture-dir-link.js"), "dir");
    fs.symlinkSync(path.join(specDir, "not-present.js"), path.join(macSpecDir, "fixture-dangling.js"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("symbolic links are unavailable");
    throw error;
  }
  const names = await createFigHandlers(electronDir).list("macos");
  assert.ok(names.includes("fixture-link"));
  assert.equal(names.includes("fixture-dir-link"), false);
  assert.equal(names.includes("fixture-dangling"), false);
});

test("each local specification directory can fail independently", async (t) => {
  const { electronDir, specDir, macSpecDir } = createSpecFixture(t);
  fs.writeFileSync(path.join(specDir, "fixture-root-only.js"), 'export default {name: "fixture-root-only"};');
  const handlers = createFigHandlers(electronDir);
  fs.rmSync(macSpecDir, { recursive: true });
  assert.ok((await handlers.list("macos")).includes("fixture-root-only"));

  fs.mkdirSync(macSpecDir);
  fs.writeFileSync(path.join(macSpecDir, "fixture-macos-only.js"), 'export default {name: "fixture-macos-only"};');
  const originalReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (dir, ...args) => {
    if (dir === specDir) {
      const error = new Error("fixture root is unreadable");
      error.code = "EACCES";
      throw error;
    }
    return originalReaddir(dir, ...args);
  });
  const list = await handlers.list("macos");
  assert.ok(list.includes("fixture-macos-only"));
  assert.equal(list.includes("fixture-root-only"), false);
});

test("missing specs return null while broken spec modules stay visible", async (t) => {
  const { electronDir, specDir } = createSpecFixture(t);
  fs.writeFileSync(path.join(specDir, "missing-import.js"), 'export { default } from "./absent-dependency.js";');
  fs.writeFileSync(path.join(specDir, "syntax-error.js"), "export default {");

  assert.equal(await loadFigSpec(electronDir, "not-present", "linux"), null);
  assert.equal(await loadFigSpec(electronDir, "not-present", "macos"), null);
  await assert.rejects(loadFigSpec(electronDir, "missing-import", "linux"), { code: "ERR_MODULE_NOT_FOUND" });
  await assert.rejects(loadFigSpec(electronDir, "syntax-error", "linux"), SyntaxError);

  const handlers = createFigHandlers(electronDir);
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await handlers.load("not-present", "linux"), null);
  assert.equal(warn.mock.calls.length, 0);
  // The bridge resolves broken modules to null so invoke never rejects.
  assert.equal(await handlers.load("missing-import", "linux"), null);
  assert.equal(await handlers.load("syntax-error", "linux"), null);
  assert.equal(warn.mock.calls.length, 2);
});
