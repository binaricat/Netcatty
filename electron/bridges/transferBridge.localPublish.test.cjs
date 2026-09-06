"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("./transferBridge.cjs");
const temp = require("./tempDirBridge.cjs");

for (const restore of [false, true]) {
  test(`local ${restore ? "restore" : "publish"} never overwrites a last-moment concurrent file`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-race")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    fs.writeFileSync(staged, "download");
    fs.writeFileSync(target, "original");
    let injected = false;
    for (const method of ["rename", "link"]) {
      const original = fs.promises[method];
      t.after(() => { fs.promises[method] = original; });
      fs.promises[method] = async (...args) => {
        if (!injected && args[1] === target && String(args[0]).endsWith(restore ? ".backup" : ".ready")) {
          injected = true;
          fs.writeFileSync(target, "concurrent");
        }
        return original.apply(fs.promises, args);
      };
    }
    await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target,
      restore ? { validateTarget: async () => ({ stableIdentity: "wrong" }) } : {}));
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
    const backup = fs.readdirSync(root).find(name => name.endsWith(".backup"));
    assert.ok(backup, "retain original for recovery");
    assert.equal(fs.readFileSync(path.join(root, backup), "utf8"), "original");
  });
}

test("an explicitly absent destination is never moved aside if another writer creates it", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-absent")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    validateTarget: async () => {
      fs.writeFileSync(target, "concurrent");
      return { targetIdentity: "missing", existingMode: null };
    },
  }));
  assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
});

for (const failCopy of [false, true]) {
  test(`exclusive copy fallback ${failCopy ? "retains recovery files after a write failure" : "publishes complete bytes without hardlinks"}`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-fallback")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    const payload = Buffer.alloc(2 * 1024 * 1024 + 7, 173);
    fs.writeFileSync(staged, payload);
    fs.writeFileSync(target, "original");
    const link = fs.promises.link;
    fs.promises.link = async () => { throw Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" }); };
    t.after(() => { fs.promises.link = link; });
    if (failCopy) {
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        const handle = await open.apply(fs.promises, args);
        if (args[0] === target && args[1] === "wx") {
          handle.write = async () => {
            // A replacement entry must survive even when the owned old handle fails.
            fs.unlinkSync(target);
            fs.writeFileSync(target, "concurrent");
            throw new Error("disk write failed");
          };
        }
        return handle;
      };
      t.after(() => { fs.promises.open = open; });
      await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target), /Recovery files preserved/);
      assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
      const names = fs.readdirSync(root);
      assert.deepEqual(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".ready")))), payload);
      assert.equal(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".backup"))), "utf8"), "original");
    } else {
      await bridge._promoteLocalTransferForTests(staged, target);
      assert.deepEqual(fs.readFileSync(target), payload);
      assert.deepEqual(fs.readdirSync(root), ["target"]);
    }
  });
}

test("cancellation before publication restores the original destination", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-cancel")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    assertNotCancelled: () => { if (!fs.existsSync(target)) throw new Error("Transfer cancelled"); },
  }), /cancelled/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

for (const interruption of ["cancel", "replace", "restore-replace"]) {
  test(`fallback ${interruption} during copying preserves complete recovery files`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-mid-copy")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    const payload = Buffer.alloc(3 * 1024 * 1024, 42);
    fs.writeFileSync(staged, payload);
    fs.writeFileSync(target, "original");
    const link = fs.promises.link;
    const open = fs.promises.open;
    let cancelled = false;
    let writes = 0;
    fs.promises.link = async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
    fs.promises.open = async (...args) => {
      const handle = await open.apply(fs.promises, args);
      if (args[0] === target && args[1] === "wx") {
        const write = handle.write.bind(handle);
        handle.write = async (...writeArgs) => {
          const result = await write(...writeArgs);
          if (++writes === 1) {
            if (interruption === "cancel") cancelled = true;
            else { fs.unlinkSync(target); fs.writeFileSync(target, "concurrent"); }
          }
          return result;
        };
      }
      return handle;
    };
    t.after(() => { fs.promises.link = link; fs.promises.open = open; });
    let committed = false;
    await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
      ...(interruption === "restore-replace" ? { validateTarget: async () => ({ stableIdentity: "wrong" }) } : {}),
      assertNotCancelled() { if (cancelled) throw new Error("Transfer cancelled"); },
      onCommit() { committed = true; },
    }), /Recovery files preserved/);
    assert.equal(committed, false);
    if (interruption === "cancel") assert.equal(writes, 1);
    else assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
    const names = fs.readdirSync(root);
    assert.deepEqual(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".ready")))), payload);
    assert.equal(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".backup"))), "utf8"), "original");
  });
}

test("cancelled replacement restores original timestamps through the copy fallback", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-restore-times")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original", { mode: 0o640 });
  const atime = new Date("2019-01-02T00:00:00Z");
  const mtime = new Date("2020-02-03T00:00:00Z");
  fs.utimesSync(target, atime, mtime);
  const link = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
  t.after(() => { fs.promises.link = link; });
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    assertNotCancelled() { if (!fs.existsSync(target)) throw new Error("Transfer cancelled"); },
  }), /cancelled/);
  const stat = fs.statSync(target);
  assert.equal(stat.mtimeMs, mtime.getTime());
  assert.equal(stat.atimeMs, atime.getTime());
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});
