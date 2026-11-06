"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginFilesystemBroker, MAX_FILESYSTEM_BYTES } = require("./filesystemBroker.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function createRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-filesystem-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function runtimeContext(authorization) {
  return {
    runtimeId: "runtime-1",
    authorization,
    assertActive: async () => {},
  };
}

async function openTestDirectoryHandle(directoryPath) {
  const stats = await fsp.stat(directoryPath);
  const directory = await fsp.opendir(directoryPath);
  return {
    stat: async () => stats,
    read: () => directory.read(),
    close: async () => {
      try { await directory.close(); }
      catch (error) { if (error?.code !== "ERR_DIR_CLOSED") throw error; }
    },
  };
}

test("filesystem broker uses canonical authorization for bounded read, write, stat, and list", async (context) => {
  const root = createRoot(context);
  const source = path.join(root, "source.txt");
  const target = path.join(root, "target.txt");
  await Promise.all([
    fsp.writeFile(source, "hello"),
    fsp.writeFile(target, "prior"),
  ]);
  const charges = [];
  const broker = new PluginFilesystemBroker({
    quotaManager: { chargeBytes: (...args) => charges.push(args) },
    openDirectoryHandle: openTestDirectoryHandle,
  });

  const readAuthorization = await broker.describeReadAuthorization({ path: source });
  assert.deepEqual(readAuthorization.resourceKinds, ["exact"]);
  assert.deepEqual(
    await broker.readFile({ path: source }, runtimeContext(readAuthorization)),
    { data: "hello" },
  );
  assert.equal((await broker.stat({ path: source }, runtimeContext(readAuthorization))).kind, "file");

  const writeAuthorization = await broker.describeWriteAuthorization({
    path: target,
    data: "world",
    overwrite: true,
  });
  assert.deepEqual(writeAuthorization.resourceKinds, ["exact"]);
  await broker.writeFile({
    path: target,
    data: "world",
    overwrite: true,
  }, runtimeContext(writeAuthorization));
  assert.equal(await fsp.readFile(target, "utf8"), "world");
  const overwriteAuthorization = await broker.describeWriteAuthorization({
    path: target,
    data: "short",
    overwrite: true,
  });
  await broker.writeFile(
    { path: target, data: "short", overwrite: true },
    runtimeContext(overwriteAuthorization),
  );
  assert.equal(await fsp.readFile(target, "utf8"), "short");

  const listAuthorization = await broker.describeReadAuthorization({ path: root }, "directory");
  assert.deepEqual(listAuthorization.resourceKinds, ["directory"]);
  const list = await broker.readDirectory({ path: root }, runtimeContext(listAuthorization));
  assert.deepEqual(list.entries.map(({ name }) => name), ["source.txt", "target.txt"]);
  assert.deepEqual(charges, [
    ["runtime-1", "filesystem", 5],
    ["runtime-1", "filesystem", 5],
    ["runtime-1", "filesystem", 5],
  ]);
});

test("host conversation roots are unreadable through explicit filesystem grants, including symlink aliases", async (context) => {
  const root = createRoot(context); const privateRoot = path.join(root, "agent-chats");
  await fsp.mkdir(privateRoot); const file = path.join(privateRoot, "synthetic.json"); await fsp.writeFile(file, "PRIVATE_OTHER_SOURCE_HISTORY");
  const broker = new PluginFilesystemBroker({ protectedReadDirectories: [privateRoot], openDirectoryHandle: openTestDirectoryHandle });
  const authorize = (candidate, kind = "exact") => runtimeContext(broker.describeReadAuthorization({ path: candidate }, kind));
  await assert.rejects(broker.readFile({ path: file }, authorize(file)), (error) => error.code === RPC_ERRORS.permissionDenied);
  await assert.rejects(broker.stat({ path: privateRoot }, authorize(privateRoot)), (error) => error.code === RPC_ERRORS.permissionDenied);
  await assert.rejects(broker.readDirectory({ path: privateRoot }, authorize(privateRoot, "directory")), (error) => error.code === RPC_ERRORS.permissionDenied);
  if (process.platform !== "win32") {
    const alias = path.join(root, "alias.json"); await fsp.symlink(file, alias);
    await assert.rejects(broker.readFile({ path: alias }, authorize(root, "directory")), (error) => error.code === RPC_ERRORS.permissionDenied);
    const directoryAlias = path.join(root, "directory-alias"); await fsp.symlink(privateRoot, directoryAlias);
    await assert.rejects(broker.readDirectory({ path: directoryAlias }, authorize(root, "directory")), (error) => error.code === RPC_ERRORS.permissionDenied);
  }
  const ordinary = path.join(root, "ordinary.txt"); await fsp.writeFile(ordinary, "Synthetic public file");
  assert.deepEqual(await broker.readFile({ path: ordinary }, authorize(ordinary)), { data: "Synthetic public file" });
});

test("filesystem authorization removes trailing directory separators before permission", async (context) => {
  const root = createRoot(context);
  const requestedPath = `${root}${path.sep}`;
  await fsp.writeFile(path.join(root, "entry.txt"), "entry");
  const broker = new PluginFilesystemBroker({ openDirectoryHandle: openTestDirectoryHandle });
  const statAuthorization = broker.describeReadAuthorization({ path: requestedPath }, "exact");
  const listAuthorization = broker.describeReadAuthorization({ path: requestedPath }, "directory");

  assert.deepEqual(statAuthorization.resources, [root]);
  assert.deepEqual(listAuthorization.resources, [root]);
  assert.equal(
    (await broker.stat({ path: requestedPath }, runtimeContext(statAuthorization))).kind,
    "directory",
  );
  assert.deepEqual(
    (await broker.readDirectory({ path: requestedPath }, runtimeContext(listAuthorization))).entries,
    [{ name: "entry.txt", kind: "file" }],
  );
});

test("filesystem write quota is enforced before mutating the target", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "target.txt");
  await fsp.writeFile(target, "original");
  const broker = new PluginFilesystemBroker({
    quotaManager: { chargeBytes: () => { throw new Error("quota denied"); } },
  });
  const authorization = await broker.describeWriteAuthorization({
    path: target,
    data: "blocked",
    overwrite: true,
  });
  await assert.rejects(
    broker.writeFile({
      path: target,
      data: "blocked",
      overwrite: true,
    }, runtimeContext(authorization)),
    /quota denied/,
  );
  assert.equal(await fsp.readFile(target, "utf8"), "original");
});

test("filesystem authorization descriptors never probe path existence before permission", async (context) => {
  const root = createRoot(context);
  const missing = path.join(root, "missing.txt");
  let filesystemCalls = 0;
  const broker = new PluginFilesystemBroker({
    fileSystem: new Proxy({}, {
      get() {
        return async () => {
          filesystemCalls += 1;
          throw new Error("filesystem must not be queried while describing authorization");
        };
      },
    }),
  });
  assert.deepEqual(broker.describeReadAuthorization({ path: missing }), {
    permission: "filesystem.read",
    resources: [missing],
    resourceKinds: ["exact"],
    reason: `Read ${missing}`,
    operationId: `filesystem.read:${missing}`,
  });
  assert.deepEqual(broker.describeReadAuthorization({ path: root }, "directory").resourceKinds, ["directory"]);
  assert.deepEqual(broker.describeWriteAuthorization({
    path: missing,
    data: "blocked",
    overwrite: true,
  }).resources, [missing]);
  await assert.rejects(
    broker.readFile({ path: missing }, runtimeContext(null)),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
  await assert.rejects(
    broker.writeFile(
      { path: missing, data: "blocked", overwrite: true },
      runtimeContext(null),
    ),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
  assert.equal(filesystemCalls, 0);
});

test("filesystem writes reject missing targets without opening or creating them", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "missing.txt");
  let openCalls = 0;
  const broker = new PluginFilesystemBroker({
    fileSystem: {
      ...fsp,
      async open(...args) {
        openCalls += 1;
        return fsp.open(...args);
      },
    },
  });
  const authorization = broker.describeWriteAuthorization({
    path: target,
    data: "blocked",
    overwrite: true,
  });
  await assert.rejects(
    broker.writeFile(
      { path: target, data: "blocked", overwrite: true },
      runtimeContext(authorization),
    ),
    (error) => error.code === RPC_ERRORS.failedPrecondition,
  );
  assert.equal(openCalls, 0);
  await assert.rejects(fsp.stat(target), (error) => error.code === "ENOENT");
});

test("filesystem path swaps after authorization fail closed", async (context) => {
  const root = createRoot(context);
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  const link = path.join(root, "selected.txt");
  await Promise.all([fsp.writeFile(first, "first"), fsp.writeFile(second, "second")]);
  await fsp.symlink(first, link);
  const broker = new PluginFilesystemBroker();
  const authorization = await broker.describeReadAuthorization({ path: link });
  await fsp.unlink(link);
  await fsp.symlink(second, link);
  await assert.rejects(
    broker.readFile({ path: link }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
});

test("filesystem directory replacement between authorization and open fails closed", async (context) => {
  const root = createRoot(context);
  const selected = path.join(root, "selected");
  const replacement = path.join(root, "replacement");
  const original = path.join(root, "original");
  await Promise.all([
    fsp.mkdir(selected),
    fsp.mkdir(replacement),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(selected, "allowed.txt"), "allowed"),
    fsp.writeFile(path.join(replacement, "secret.txt"), "secret"),
  ]);
  let swapped = false;
  const broker = new PluginFilesystemBroker({
    openDirectoryHandle: async (directoryPath) => {
      if (!swapped) {
        swapped = true;
        await fsp.rename(selected, original);
        await fsp.rename(replacement, selected);
      }
      return openTestDirectoryHandle(directoryPath);
    },
  });
  const authorization = await broker.describeReadAuthorization({ path: selected }, "directory");
  await assert.rejects(
    broker.readDirectory({ path: selected }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
});

test("filesystem directory listing fails closed without a handle-bound adapter", async (context) => {
  const root = createRoot(context);
  await fsp.writeFile(path.join(root, "entry.txt"), "entry");
  const broker = new PluginFilesystemBroker();
  const authorization = broker.describeReadAuthorization({ path: root }, "directory");
  await assert.rejects(
    broker.readDirectory({ path: root }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.unsupported,
  );
});

test("filesystem writes recheck runtime activity immediately before mutation", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "target.txt");
  await fsp.writeFile(target, "original");
  let active = true;
  let armed = false;
  const broker = new PluginFilesystemBroker({
    fileSystem: {
      ...fsp,
      async stat(filePath, options) {
        const stats = await fsp.stat(filePath, options);
        if (armed) active = false;
        return stats;
      },
    },
  });
  const authorization = await broker.describeWriteAuthorization({
    path: target,
    data: "replacement",
    overwrite: true,
  });
  armed = true;
  await assert.rejects(broker.writeFile({
    path: target,
    data: "replacement",
    overwrite: true,
  }, {
    ...runtimeContext(authorization),
    assertActive: async () => { if (!active) throw new Error("runtime stopped"); },
  }), /runtime stopped/);
  assert.equal(await fsp.readFile(target, "utf8"), "original");
});

test("filesystem reads reject a replacement inode opened after authorization", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "selected.txt");
  const original = path.join(root, "original.txt");
  const replacement = path.join(root, "replacement.txt");
  await Promise.all([
    fsp.writeFile(target, "allowed"),
    fsp.writeFile(replacement, "secret"),
  ]);
  let swapped = false;
  const broker = new PluginFilesystemBroker({
    fileSystem: {
      ...fsp,
      async open(filePath, flags, mode) {
        if (!swapped) {
          swapped = true;
          await fsp.rename(target, original);
          await fsp.rename(replacement, target);
        }
        return fsp.open(filePath, flags, mode);
      },
    },
  });
  const authorization = broker.describeReadAuthorization({ path: target });
  await assert.rejects(
    broker.readFile({ path: target }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
});

test("filesystem writes reject a replacement inode opened after authorization", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "selected.txt");
  const original = path.join(root, "original.txt");
  const replacement = path.join(root, "replacement.txt");
  await Promise.all([
    fsp.writeFile(target, "allowed"),
    fsp.writeFile(replacement, "secret"),
  ]);
  let swapped = false;
  const broker = new PluginFilesystemBroker({
    fileSystem: {
      ...fsp,
      async open(filePath, flags, mode) {
        if (!swapped) {
          swapped = true;
          await fsp.rename(target, original);
          await fsp.rename(replacement, target);
        }
        return fsp.open(filePath, flags, mode);
      },
    },
  });
  const authorization = broker.describeWriteAuthorization({
    path: target,
    data: "overwritten",
    overwrite: true,
  });
  await assert.rejects(
    broker.writeFile({
      path: target,
      data: "overwritten",
      overwrite: true,
    }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
  assert.equal(await fsp.readFile(original, "utf8"), "allowed");
  assert.equal(await fsp.readFile(target, "utf8"), "secret");
});

test("filesystem broker rejects oversized and non-canonical payloads", async (context) => {
  const root = createRoot(context);
  const target = path.join(root, "target.bin");
  const broker = new PluginFilesystemBroker();
  assert.throws(() => broker.validateWrite({
    path: target,
    data: "YQ",
    encoding: "base64",
  }), /not canonical/);
  assert.throws(() => broker.validateWrite({
    path: target,
    data: "a".repeat(MAX_FILESYSTEM_BYTES + 1),
  }), (error) => error.code === RPC_ERRORS.resourceExhausted);
  assert.throws(() => broker.validateRead({ path: `${target}\0suffix` }), /absolute/);

  await fsp.writeFile(target, "12345");
  const authorization = await broker.describeReadAuthorization({ path: target, maxBytes: 4 });
  await assert.rejects(
    broker.readFile({ path: target, maxBytes: 4 }, runtimeContext(authorization)),
    (error) => error.code === RPC_ERRORS.resourceExhausted,
  );
});

test("plugin writes cannot modify host audit files or preferences, including symlink aliases", async (t) => {
  const root = createRoot(t);
  const directory = path.join(root, "host-logs");
  await fsp.mkdir(directory);
  const audit = path.join(directory, "runtime.jsonl");
  const preferences = path.join(root, "local-logging.json");
  await fsp.writeFile(audit, "host audit");
  await fsp.writeFile(preferences, "host preferences");
  const alias = path.join(root, "alias");
  await fsp.symlink(audit, alias);
  const broker = new PluginFilesystemBroker({ protectedDirectories: [directory], protectedFiles: [preferences] });
  for (const target of [audit, preferences, alias]) {
    const authorization = broker.describeWriteAuthorization({ path: target, data: "overwrite", overwrite: true });
    await assert.rejects(broker.writeFile({ path: target, data: "overwrite", overwrite: true }, runtimeContext(authorization)), { code: RPC_ERRORS.permissionDenied });
  }
  assert.equal(await fsp.readFile(audit, "utf8"), "host audit");
  assert.equal(await fsp.readFile(preferences, "utf8"), "host preferences");
});

test("host audit protection resolves a symlinked userData directory", async (t) => {
  const root = createRoot(t);
  const actual = path.join(root, "actual-profile");
  await fsp.mkdir(path.join(actual, "logs"), { recursive: true });
  const profileAlias = path.join(root, "profile-alias");
  await fsp.symlink(actual, profileAlias);
  const target = path.join(actual, "logs", "runtime.jsonl");
  await fsp.writeFile(target, "host audit");
  const broker = new PluginFilesystemBroker({ protectedDirectories: [path.join(profileAlias, "logs")] });
  const params = { path: target, data: "overwrite", overwrite: true };
  const authorization = broker.describeWriteAuthorization(params);
  await assert.rejects(broker.writeFile(params, runtimeContext(authorization)), { code: RPC_ERRORS.permissionDenied });
  assert.equal(await fsp.readFile(target, "utf8"), "host audit");
});

test("revocation during the protected-storage check cannot write an unrelated granted file", async (t) => {
  const root = createRoot(t);
  const logs = path.join(root, "host-logs");
  const target = path.join(root, "synthetic.txt");
  await fsp.mkdir(logs);
  await fsp.writeFile(target, "prior");
  let checks = 0;
  let active = true;
  const broker = new PluginFilesystemBroker({ protectedDirectories: [logs], fileSystem: {
    ...fsp, async realpath(requested) {
      const canonical = await fsp.realpath(requested);
      if (requested === logs && ++checks === 3) active = false;
      return canonical;
    },
  } });
  const params = { path: target, data: "overwrite", overwrite: true };
  const authorization = broker.describeWriteAuthorization(params);
  const context = { ...runtimeContext(authorization), async assertActive() {
    if (!active) throw Object.assign(new Error("synthetic revocation"), { code: RPC_ERRORS.permissionDenied });
  } };
  await assert.rejects(broker.writeFile(params, context), { code: RPC_ERRORS.permissionDenied });
  assert.equal(await fsp.readFile(target, "utf8"), "prior");
});
