const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const tempDirBridge = require("./tempDirBridge.cjs");

function isolatedTempChildEnv(root, home, extra = {}) {
  return {
    ...process.env,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    HOME: home,
    ...extra,
  };
}

test("getTempFilePath is unique for duplicate names in the same millisecond", () => {
  const originalNow = Date.now;
  Date.now = () => 1234567890;
  try {
    const first = tempDirBridge.getTempFilePath("upload.txt");
    const second = tempDirBridge.getTempFilePath("upload.txt");

    assert.notEqual(first, second);
    assert.equal(path.basename(first).endsWith("_upload.txt"), true);
    assert.equal(path.basename(second).endsWith("_upload.txt"), true);
  } finally {
    Date.now = originalNow;
  }
});

test("Netcatty temp root is a private directory owned by the current user", () => {
  const tempRoot = tempDirBridge.getTempDir();
  const stat = fs.lstatSync(tempRoot);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o700);
  if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid());
  assert.equal(tempDirBridge.getTempDir(), tempRoot);
});

test("shared system temp roots resolve to a stable path under the user's home", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-shared-root-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o777);
  try {
    if (typeof process.getuid === "function") {
      assert.equal(tempDirBridge.resolvePrivateTempDir(root, fakeHome), path.join(fakeHome, ".netcatty", "tmp", "Netcatty"));
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("cached temp root is recreated after OS cleanup", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-private-root-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  try {
    const script = [
      'const fs = require("node:fs");',
      'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
      'const first = bridge.getTempDir();',
      'fs.rmSync(first, { recursive: true, force: true });',
      'const second = bridge.getTempDir();',
      'if (first !== second || !fs.statSync(second).isDirectory()) process.exit(2);',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: isolatedTempChildEnv(root, fakeHome),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("cached temp root is rebound after inode replacement", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-replaced-root-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  try {
    const script = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
      'const first = bridge.getTempDir();',
      'const oldPath = `${first}.old`;',
      'fs.renameSync(first, oldPath);',
      'fs.mkdirSync(first, { recursive: true, mode: 0o700 });',
      'const oldStat = fs.lstatSync(oldPath);',
      'const second = bridge.getTempDir();',
      'const newStat = fs.lstatSync(second);',
      'if (!newStat.isDirectory()) process.exit(2);',
      'if (oldStat.dev === newStat.dev && oldStat.ino === newStat.ino) process.exit(4);',
      'const downloadPath = bridge.getTempFilePath("download.bin");',
      'const relative = path.relative(second, downloadPath);',
      'if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) process.exit(3);',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: isolatedTempChildEnv(root, fakeHome),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("tool output signing key reloads when the temp root inode is replaced", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-rebind-key-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
    'const handlers = new Map();',
    'const secret = process.env.FAKE_SAFE_STORAGE_SECRET;',
    'const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    '  encryptString: value => Buffer.from(`${secret}:${value}`, "utf8"),',
    '  decryptString: value => {',
    '    const text = value.toString("utf8");',
    '    if (!text.startsWith(`${secret}:`)) throw new Error("wrong key");',
    '    return text.slice(secret.length + 1);',
    '  },',
    '};',
    'bridge.registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, undefined, { safeStorage });',
    '(async () => {',
    '  if (process.env.PHASE === "write") {',
    '    const first = bridge.getTempDir();',
    '    const now = Date.now();',
    '    const before = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '      record: { schemaVersion: 1, handleId: "before-rebind", chatSessionId: "rebind-chat", capabilityId: "terminal.execute", totalChars: 6, storedChars: 6, sourceTruncated: false, preview: "before", storedAt: now, accessedAt: now },',
    '      content: "before",',
    '    });',
    '    if (!before.ok) throw new Error(before.error);',
    '    const oldPath = `${first}.old`;',
    '    fs.renameSync(first, oldPath);',
    '    fs.mkdirSync(first, { recursive: true, mode: 0o700 });',
    '    const replacementKey = Buffer.alloc(32, 7);',
    '    fs.writeFileSync(path.join(first, ".tool-output-signing-key"), safeStorage.encryptString(replacementKey.toString("base64")), { mode: 0o600 });',
    '    bridge.getTempDir();',
    '    const after = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '      record: { schemaVersion: 1, handleId: "after-rebind", chatSessionId: "rebind-chat", capabilityId: "terminal.execute", totalChars: 5, storedChars: 5, sourceTruncated: false, preview: "after", storedAt: now, accessedAt: now },',
    '      content: "after",',
    '    });',
    '    console.log(`RESULT:${JSON.stringify(after)}`);',
    '    return;',
    '  }',
    '  const restored = await handlers.get("netcatty:tempdir:toolOutputRestore")({}, { handleId: "after-rebind", chatSessionId: "rebind-chat" });',
    '  const content = restored ? await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: restored.path }) : null;',
    '  console.log(`RESULT:${JSON.stringify({ restored: Boolean(restored), content })}`);',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join("\n");
  const run = phase => spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, "../.."),
    env: isolatedTempChildEnv(root, fakeHome, {
      PHASE: phase,
      FAKE_SAFE_STORAGE_SECRET: "rebind-secret",
    }),
    encoding: "utf8",
  });
  try {
    const written = run("write");
    assert.equal(written.status, 0, written.stderr || written.stdout);
    assert.match(written.stdout, /RESULT:.*"ok":true/);
    const reopened = run("read");
    assert.equal(reopened.status, 0, reopened.stderr || reopened.stdout);
    assert.match(reopened.stdout, /RESULT:.*"restored":true.*"content":"after"/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("tool output write retries when the temp root is replaced after key loading starts", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-rebind-write-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
    'const handlers = new Map();',
    'const secret = process.env.FAKE_SAFE_STORAGE_SECRET;',
    'const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    '  encryptString: value => Buffer.from(`${secret}:${value}`, "utf8"),',
    '  decryptString: value => {',
    '    const text = value.toString("utf8");',
    '    if (!text.startsWith(`${secret}:`)) throw new Error("wrong key");',
    '    return text.slice(secret.length + 1);',
    '  },',
    '};',
    'bridge.registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, undefined, { safeStorage });',
    '(async () => {',
    '  const now = Date.now();',
    '  const first = bridge.getTempDir();',
    '  const before = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '    record: { schemaVersion: 1, handleId: "before-rebind-write", chatSessionId: "rebind-write-chat", capabilityId: "terminal.execute", totalChars: 6, storedChars: 6, sourceTruncated: false, preview: "before", storedAt: now, accessedAt: now },',
    '    content: "before",',
    '  });',
    '  if (!before.ok) throw new Error(before.error);',
    '  const originalOpen = fs.promises.open;',
    '  let replaced = false;',
    '  fs.promises.open = async (filePath, ...args) => {',
    '    const opened = await originalOpen(filePath, ...args);',
    '    if (replaced || path.basename(filePath) !== ".tool-output-signing-key") return opened;',
    '    const originalRead = opened.read.bind(opened);',
    '    opened.read = async (...readArgs) => {',
    '      const oldKeyFile = await originalRead(...readArgs);',
    '      replaced = true;',
    '      const oldPath = `${first}.old`;',
    '      fs.renameSync(first, oldPath);',
    '      fs.mkdirSync(first, { recursive: true, mode: 0o700 });',
    '      const replacementKey = Buffer.alloc(32, 7);',
    '      fs.writeFileSync(path.join(first, ".tool-output-signing-key"), safeStorage.encryptString(replacementKey.toString("base64")), { mode: 0o600 });',
    '      return oldKeyFile;',
    '    };',
    '    return opened;',
    '  };',
    '  bridge.registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, undefined, { safeStorage });',
    '  const after = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '    record: { schemaVersion: 1, handleId: "after-rebind-write", chatSessionId: "rebind-write-chat", capabilityId: "terminal.execute", totalChars: 5, storedChars: 5, sourceTruncated: false, preview: "after", storedAt: now, accessedAt: now },',
    '    content: "after",',
    '  });',
    '  const restored = await handlers.get("netcatty:tempdir:toolOutputRestore")({}, { handleId: "after-rebind-write", chatSessionId: "rebind-write-chat" });',
    '  const content = restored ? await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: restored.path }) : null;',
    '  console.log(`RESULT:${JSON.stringify({ write: after, replaced, restored: Boolean(restored), content })}`);',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: isolatedTempChildEnv(root, fakeHome, { FAKE_SAFE_STORAGE_SECRET: "rebind-write-secret" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RESULT:.*"write":\{"ok":true,.*"replaced":true.*"restored":true.*"content":"after"/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("tool output restore retries when the temp root is replaced during content verification", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-rebind-restore-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const crypto = require("node:crypto");',
    'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
    'const handlers = new Map();',
    'const secret = process.env.FAKE_SAFE_STORAGE_SECRET;',
    'const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    '  encryptString: value => Buffer.from(`${secret}:${value}`, "utf8"),',
    '  decryptString: value => {',
    '    const text = value.toString("utf8");',
    '    if (!text.startsWith(`${secret}:`)) throw new Error("wrong key");',
    '    return text.slice(secret.length + 1);',
    '  },',
    '};',
    'bridge.registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, undefined, { safeStorage });',
    '(async () => {',
    '  const now = Date.now();',
    '  const first = bridge.getTempDir();',
    '  const record = { schemaVersion: 1, handleId: "restore-rebind", chatSessionId: "restore-rebind-chat", capabilityId: "terminal.execute", totalChars: 6, storedChars: 6, sourceTruncated: false, preview: "before", storedAt: now, accessedAt: now };',
    '  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, { record, content: "before" });',
    '  if (!saved.ok) throw new Error(saved.error);',
    '  const originalOpen = fs.promises.open;',
    '  let rebound = false;',
    '  fs.promises.open = async (filePath, ...args) => {',
    '    const opened = await originalOpen(filePath, ...args);',
    '    if (rebound || path.resolve(String(filePath)) !== path.resolve(saved.path)) return opened;',
    '    rebound = true;',
    '    const oldPath = `${first}.old`;',
    '    fs.renameSync(first, oldPath);',
    '    fs.mkdirSync(first, { recursive: true, mode: 0o700 });',
    '    const replacementKey = Buffer.alloc(32, 7);',
    '    fs.writeFileSync(path.join(first, ".tool-output-signing-key"), safeStorage.encryptString(replacementKey.toString("base64")), { mode: 0o600 });',
    '    bridge.getTempDir();',
    '    const contentBuffer = Buffer.from("after", "utf16le");',
    '    fs.writeFileSync(saved.path, contentBuffer, { mode: 0o600, flag: "wx" });',
    '    const manifest = {',
    '      record,',
    '      contentFile: path.basename(saved.path),',
    '      contentBytes: contentBuffer.length,',
    '      contentSha256: crypto.createHash("sha256").update(contentBuffer).digest("hex"),',
    '    };',
    '    manifest.signature = crypto.createHmac("sha256", replacementKey)',
    '      .update(JSON.stringify({ record: manifest.record, contentFile: manifest.contentFile, contentBytes: manifest.contentBytes, contentSha256: manifest.contentSha256 }))',
    '      .digest("hex");',
    '    fs.writeFileSync(`${saved.path}.meta.json`, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });',
    '    return opened;',
    '  };',
    '  const restored = await handlers.get("netcatty:tempdir:toolOutputRestore")({}, { handleId: "restore-rebind", chatSessionId: "restore-rebind-chat" });',
    '  const content = restored ? await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: restored.path }) : null;',
    '  console.log(`RESULT:${JSON.stringify({ rebound, restored: Boolean(restored), content })}`);',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: isolatedTempChildEnv(root, fakeHome, { FAKE_SAFE_STORAGE_SECRET: "rebind-restore-secret" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RESULT:.*"rebound":true.*"restored":true.*"content":"after"/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("tool output write keeps the loaded key during a temporary keychain failure", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-keychain-write-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  const script = [
    'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
    'const handlers = new Map();',
    'const secret = process.env.FAKE_SAFE_STORAGE_SECRET;',
    'let keychainLocked = false;',
    'const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    '  encryptString: value => Buffer.from(`${secret}:${value}`, "utf8"),',
    '  decryptString: value => {',
    '    if (keychainLocked) throw new Error("keychain locked");',
    '    const text = value.toString("utf8");',
    '    if (!text.startsWith(`${secret}:`)) throw new Error("wrong key");',
    '    return text.slice(secret.length + 1);',
    '  },',
    '};',
    'bridge.registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, undefined, { safeStorage });',
    '(async () => {',
    '  const now = Date.now();',
    '  const before = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '    record: { schemaVersion: 1, handleId: "before-keychain-lock", chatSessionId: "keychain-write-chat", capabilityId: "terminal.execute", totalChars: 6, storedChars: 6, sourceTruncated: false, preview: "before", storedAt: now, accessedAt: now },',
    '    content: "before",',
    '  });',
    '  if (!before.ok) throw new Error(before.error);',
    '  keychainLocked = true;',
    '  const after = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '    record: { schemaVersion: 1, handleId: "after-keychain-lock", chatSessionId: "keychain-write-chat", capabilityId: "terminal.execute", totalChars: 5, storedChars: 5, sourceTruncated: false, preview: "after", storedAt: now, accessedAt: now },',
    '    content: "after",',
    '  });',
    '  console.log(`RESULT:${JSON.stringify(after)}`);',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: isolatedTempChildEnv(root, fakeHome, { FAKE_SAFE_STORAGE_SECRET: "keychain-write-secret" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RESULT:.*"ok":true/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("tool output temp handlers write, read, and delete only Netcatty temp files", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  const write = handlers.get("netcatty:tempdir:toolOutputWrite");
  const read = handlers.get("netcatty:tempdir:toolOutputRead");
  const restore = handlers.get("netcatty:tempdir:toolOutputRestore");
  const remove = handlers.get("netcatty:tempdir:toolOutputDelete");
  const record = {
    schemaVersion: 1,
    handleId: "tool-output-1",
    chatSessionId: "chat-1",
    capabilityId: "terminal.execute",
    totalChars: 21,
    storedChars: 21,
    sourceTruncated: false,
    preview: "large terminal output",
    storedAt: Date.now(),
    accessedAt: Date.now(),
  };
  const saved = await write({}, { record, content: "large terminal output" });

  assert.equal(saved.ok, true);
  assert.deepEqual(await restore({}, { handleId: "tool-output-1", chatSessionId: "chat-other" }), null);
  const restored = await restore({}, { handleId: "tool-output-1", chatSessionId: "chat-1" });
  assert.equal(restored.path, saved.path);
  assert.deepEqual({ ...restored.record, accessedAt: record.accessedAt }, record);
  assert.equal(restored.record.accessedAt >= record.accessedAt, true);
  assert.equal(await read({}, { path: saved.path }), "large terminal output");
  assert.deepEqual(await read({}, {
    path: saved.path,
    request: { mode: "range", offset: 6, maxChars: 8 },
  }), {
    mode: "range",
    content: "terminal",
    totalChars: 21,
    startOffset: 6,
    endOffset: 14,
    nextOffset: 14,
    hasMore: true,
  });
  assert.deepEqual(await remove({}, { path: saved.path }), { ok: true });
  assert.equal(await restore({}, { handleId: "tool-output-1", chatSessionId: "chat-1" }), null);
  assert.equal(await read({}, { path: saved.path }), null);
  assert.deepEqual(await read({}, { path: "/etc/passwd" }), null);
});

test("tool output temp reader rejects symlinks that point outside Netcatty temp", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const linkPath = tempDirBridge.getTempFilePath("tool-output-link.log");
  await fs.promises.symlink("/etc/hosts", linkPath);
  try {
    assert.equal(await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: linkPath }), null);
  } finally {
    await fs.promises.unlink(linkPath);
  }
});

test("tool output temp writer rejects output arriving after terminal close", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const terminalSessionId = "terminal-closed-before-write";
  await handlers.get("netcatty:tempdir:toolOutputDeleteTerminal")({}, { terminalSessionId });
  const now = Date.now();
  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
    record: {
      schemaVersion: 1,
      handleId: "late-terminal-output",
      chatSessionId: "chat-late-terminal",
      capabilityId: "terminal.execute",
      terminalSessionId,
      totalChars: 4,
      storedChars: 4,
      sourceTruncated: false,
      preview: "late",
      storedAt: now,
      accessedAt: now,
    },
    content: "late",
  });

  assert.equal(saved.ok, false);
  assert.match(saved.error, /already closed/);
});

test("chat deletion wins when a persisted output write is already in flight", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const chatSessionId = `chat-deleted-during-write-${Date.now()}`;
  const handleId = `write-delete-race-${Date.now()}`;
  const originalWriteFile = fs.promises.writeFile;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  let releaseWrite;
  const writeReleased = new Promise(resolve => { releaseWrite = resolve; });
  fs.promises.writeFile = async (filePath, ...args) => {
    if (String(filePath).endsWith('.log')) {
      signalWriteStarted();
      await writeReleased;
    }
    return originalWriteFile(filePath, ...args);
  };

  try {
    const now = Date.now();
    const writing = handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
      record: {
        schemaVersion: 1,
        handleId,
        chatSessionId,
        capabilityId: "terminal.execute",
        totalChars: 6,
        storedChars: 6,
        sourceTruncated: false,
        preview: "secret",
        storedAt: now,
        accessedAt: now,
      },
      content: "secret",
    });
    await writeStarted;
    await handlers.get("netcatty:tempdir:toolOutputDeleteSession")({}, { chatSessionId });
    releaseWrite();

    const saved = await writing;
    assert.equal(saved.ok, false);
    assert.match(saved.error, /cleared while output was being saved/);
    assert.equal(
      await handlers.get("netcatty:tempdir:toolOutputRestore")({}, { handleId, chatSessionId }),
      null,
    );

    const later = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
      record: {
        schemaVersion: 1,
        handleId: `${handleId}-later`,
        chatSessionId,
        capabilityId: "terminal.execute",
        totalChars: 5,
        storedChars: 5,
        sourceTruncated: false,
        preview: "later",
        storedAt: Date.now(),
        accessedAt: Date.now(),
      },
      content: "later",
    });
    assert.equal(later.ok, true);
    await handlers.get("netcatty:tempdir:toolOutputDelete")({}, { path: later.path });
  } finally {
    fs.promises.writeFile = originalWriteFile;
    releaseWrite?.();
  }
});

test("terminal close wins when a persisted output read is already in flight", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const terminalSessionId = "terminal-close-during-read";
  const now = Date.now();
  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
    record: {
      schemaVersion: 1,
      handleId: "read-close-race",
      chatSessionId: "chat-read-close-race",
      capabilityId: "terminal.execute",
      terminalSessionId,
      totalChars: 7,
      storedChars: 7,
      sourceTruncated: false,
      preview: "private",
      storedAt: now,
      accessedAt: now,
    },
    content: "private",
  });
  const originalOpen = fs.promises.open;
  let signalReadStarted;
  const readStarted = new Promise(resolve => { signalReadStarted = resolve; });
  let releaseRead;
  const readReleased = new Promise(resolve => { releaseRead = resolve; });
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== path.resolve(saved.path)) return handle;
    return {
      stat: handle.stat.bind(handle),
      close: handle.close.bind(handle),
      read: handle.read.bind(handle),
      readFile: async (...readArgs) => {
        signalReadStarted();
        await readReleased;
        return handle.readFile(...readArgs);
      },
    };
  };

  try {
    const reading = handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: saved.path });
    await readStarted;
    await handlers.get("netcatty:tempdir:toolOutputDeleteTerminal")({}, { terminalSessionId });
    releaseRead();

    assert.equal(await reading, null);
    assert.equal(fs.existsSync(saved.path), false);
    assert.equal(fs.existsSync(saved.manifestPath), false);
  } finally {
    fs.promises.open = originalOpen;
    releaseRead?.();
    await Promise.allSettled([
      fs.promises.unlink(saved.path),
      fs.promises.unlink(saved.manifestPath),
    ]);
  }
});

test("startup cleanup removes expired orphaned tool output files", async () => {
  const filePath = tempDirBridge.getTempFilePath("tool-output-expired.log");
  await fs.promises.writeFile(filePath, "secret");
  const old = new Date(Date.now() - 31 * 60 * 1_000);
  await fs.promises.utimes(filePath, old, old);
  const deleted = await tempDirBridge.cleanupExpiredToolOutputFiles();
  assert.equal(deleted >= 1, true);
  assert.equal(fs.existsSync(filePath), false);
});

test("startup cleanup removes abandoned pending manifests", async () => {
  const filePath = tempDirBridge.getTempFilePath("tool-output-abandoned.manifest.pending");
  await fs.promises.writeFile(filePath, "pending");
  const old = new Date(Date.now() - 31 * 60 * 1_000);
  await fs.promises.utimes(filePath, old, old);

  const deleted = await tempDirBridge.cleanupExpiredToolOutputFiles();

  assert.equal(deleted >= 1, true);
  assert.equal(fs.existsSync(filePath), false);
});

test("startup cleanup still expires tool outputs when secure storage is unavailable", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-key-unavailable-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  try {
    const script = [
      'const fs = require("node:fs");',
      'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
      'bridge.registerHandlers({ handle() {} }, undefined, { safeStorage: { isEncryptionAvailable: () => false } });',
      'const contentPath = bridge.getTempFilePath("tool-output-key-lost.log");',
      'const manifestPath = `${contentPath}.meta.json`;',
      'fs.writeFileSync(contentPath, "secret");',
      'fs.writeFileSync(manifestPath, "unreadable without key");',
      'const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);',
      'fs.utimesSync(contentPath, old, old);',
      'fs.utimesSync(manifestPath, old, old);',
      '(async () => {',
      '  const deleted = await bridge.cleanupExpiredToolOutputFiles();',
      '  console.log(JSON.stringify({ deleted, contentExists: fs.existsSync(contentPath), manifestExists: fs.existsSync(manifestPath) }));',
      '})();',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: isolatedTempChildEnv(root, fakeHome),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"deleted":2,"contentExists":false,"manifestExists":false/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("managed tool output survives short restarts and expires after thirty days", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const now = Date.now();
  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
    record: {
      schemaVersion: 1,
      handleId: "tool-output-ttl",
      chatSessionId: "chat-ttl",
      capabilityId: "terminal.execute",
      totalChars: 7,
      storedChars: 7,
      sourceTruncated: false,
      preview: "durable",
      storedAt: now,
      accessedAt: now,
    },
    content: "durable",
  });
  const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1_000);
  await Promise.all([
    fs.promises.utimes(saved.path, thirtyOneMinutesAgo, thirtyOneMinutesAgo),
    fs.promises.utimes(saved.manifestPath, thirtyOneMinutesAgo, thirtyOneMinutesAgo),
  ]);

  await tempDirBridge.cleanupExpiredToolOutputFiles();
  assert.equal(fs.existsSync(saved.path), true);
  assert.equal(fs.existsSync(saved.manifestPath), true);

  const forgedFutureMtime = new Date(now + 365 * 24 * 60 * 60 * 1_000);
  await fs.promises.utimes(saved.manifestPath, forgedFutureMtime, forgedFutureMtime);
  await tempDirBridge.cleanupExpiredToolOutputFiles(now + 31 * 24 * 60 * 60 * 1_000);
  assert.equal(fs.existsSync(saved.path), false);
  assert.equal(fs.existsSync(saved.manifestPath), false);
});

test("persisted tool output search advances only past rendered matches", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const write = handlers.get("netcatty:tempdir:toolOutputWrite");
  const read = handlers.get("netcatty:tempdir:toolOutputRead");
  const remove = handlers.get("netcatty:tempdir:toolOutputDelete");
  const now = Date.now();
  const saved = await write({}, {
    record: {
      schemaVersion: 1,
      handleId: "search-pagination",
      chatSessionId: "chat-search",
      capabilityId: "terminal.execute",
      totalChars: 23,
      storedChars: 23,
      sourceTruncated: false,
      preview: "match middle match tail",
      storedAt: now,
      accessedAt: now,
    },
    content: "match middle match tail",
  });

  try {
    const first = await read({}, {
      path: saved.path,
      request: { mode: "search", query: "match", maxChars: 1 },
    });
    assert.doesNotMatch(first.content, /No matches found/);
    assert.deepEqual(first.matchOffsets, [0]);
    assert.equal(first.nextOffset, 5);
    assert.equal(first.hasMore, true);

    const second = await read({}, {
      path: saved.path,
      request: { mode: "search", query: "match", offset: first.nextOffset, maxChars: 30 },
    });
    assert.deepEqual(second.matchOffsets, [13]);
  } finally {
    await remove({}, { path: saved.path });
  }
});

test("tool output temp restore rejects content tampering and deletes by chat session", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const now = Date.now();
  const record = {
    schemaVersion: 1,
    handleId: "tool-output-restart",
    chatSessionId: "chat-restart",
    capabilityId: "terminal.execute",
    terminalSessionId: "terminal-1",
    totalChars: 16,
    storedChars: 16,
    sourceTruncated: false,
    preview: "restart content",
    storedAt: now,
    accessedAt: now,
  };
  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
    record,
    content: "restart content!",
  });

  assert.ok(saved.manifestPath);
  assert.equal((await fs.promises.stat(saved.path)).mode & 0o777, 0o600);
  assert.equal((await fs.promises.stat(saved.manifestPath)).mode & 0o777, 0o600);

  await fs.promises.writeFile(saved.path, "tampered content", { encoding: "utf16le" });
  assert.equal(await handlers.get("netcatty:tempdir:toolOutputRestore")({}, {
    handleId: record.handleId,
    chatSessionId: record.chatSessionId,
  }), null);
  assert.equal(fs.existsSync(saved.path), false);
  assert.equal(fs.existsSync(saved.manifestPath), false);

  const deleted = await handlers.get("netcatty:tempdir:toolOutputDeleteSession")({}, {
    chatSessionId: record.chatSessionId,
  });
  assert.equal(deleted.deletedCount, 0);
  assert.equal(fs.existsSync(saved.path), false);
  assert.equal(fs.existsSync(saved.manifestPath), false);
});

test("tool output ownership metadata cannot be reassigned to another chat", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const now = Date.now();
  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
    record: {
      schemaVersion: 1,
      handleId: "tool-output-owned",
      chatSessionId: "chat-owner",
      capabilityId: "terminal.execute",
      totalChars: 7,
      storedChars: 7,
      sourceTruncated: false,
      preview: "private",
      storedAt: now,
      accessedAt: now,
    },
    content: "private",
  });
  const manifest = JSON.parse(await fs.promises.readFile(saved.manifestPath, "utf8"));
  manifest.record.chatSessionId = "chat-attacker";
  await fs.promises.writeFile(saved.manifestPath, JSON.stringify(manifest), "utf8");

  assert.equal(await handlers.get("netcatty:tempdir:toolOutputRestore")({}, {
    handleId: "tool-output-owned",
    chatSessionId: "chat-attacker",
  }), null);
  assert.equal(await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: saved.path }), null);

  await Promise.allSettled([
    fs.promises.unlink(saved.path),
    fs.promises.unlink(saved.manifestPath),
  ]);
});

test("tool output verification detects same-size edits even when mtime is restored", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const now = Date.now();
  const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {
    record: {
      schemaVersion: 1,
      handleId: "tool-output-same-mtime",
      chatSessionId: "chat-same-mtime",
      capabilityId: "terminal.execute",
      totalChars: 8,
      storedChars: 8,
      sourceTruncated: false,
      preview: "original",
      storedAt: now,
      accessedAt: now,
    },
    content: "original",
  });
  const originalStat = await fs.promises.stat(saved.path);
  await fs.promises.writeFile(saved.path, "modified", { encoding: "utf16le" });
  await fs.promises.utimes(saved.path, originalStat.atime, originalStat.mtime);

  assert.equal(await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: saved.path }), null);
  assert.equal(fs.existsSync(saved.path), false);
  assert.equal(fs.existsSync(saved.manifestPath), false);
});

test("tool output writer reports when quota enforcement evicts the new output", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const chatSessionId = `quota-eviction-${Date.now()}`;
  const write = handlers.get("netcatty:tempdir:toolOutputWrite");
  try {
    for (let index = 0; index < 64; index += 1) {
      const saved = await write({}, {
        record: {
          schemaVersion: 1,
          handleId: `quota-newer-${index}`,
          chatSessionId,
          capabilityId: "terminal.execute",
          totalChars: 1,
          storedChars: 1,
          sourceTruncated: false,
          preview: "x",
          storedAt: Date.now(),
          accessedAt: Date.now() + 60_000,
        },
        content: "x",
      });
      assert.equal(saved.ok, true);
    }

    const evicted = await write({}, {
      record: {
        schemaVersion: 1,
        handleId: "quota-old-clock",
        chatSessionId,
        capabilityId: "terminal.execute",
        totalChars: 1,
        storedChars: 1,
        sourceTruncated: false,
        preview: "y",
        storedAt: 1,
        accessedAt: 1,
      },
      content: "y",
    });
    assert.equal(evicted.ok, false);
    assert.match(evicted.error, /removed while enforcing storage limits/);
  } finally {
    await handlers.get("netcatty:tempdir:toolOutputDeleteSession")({}, { chatSessionId });
  }
});

test("tool output signing key survives a real process restart", async () => {
  const root = await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "netcatty-tool-output-restart-"));
  const fakeHome = path.join(root, "home");
  await fs.promises.mkdir(fakeHome);
  await fs.promises.chmod(root, 0o700);
  const script = [
    'const bridge = require("./electron/bridges/tempDirBridge.cjs");',
    'const handlers = new Map();',
    'const secret = process.env.FAKE_SAFE_STORAGE_SECRET;',
    'let keychainLocked = process.env.PHASE === "unlock";',
    'const safeStorage = {',
    '  isEncryptionAvailable: () => true,',
    '  encryptString: value => Buffer.from(`${secret}:${value}`, "utf8"),',
    '  decryptString: value => {',
    '    if (keychainLocked) throw new Error("keychain locked");',
    '    const text = value.toString("utf8");',
    '    if (!text.startsWith(`${secret}:`)) throw new Error("wrong key");',
    '    return text.slice(secret.length + 1);',
    '  },',
    '};',
    'bridge.registerHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, undefined, { safeStorage });',
    '(async () => {',
    '  if (process.env.PHASE === "write") {',
    '    const now = Date.now();',
    '    const saved = await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '      record: { schemaVersion: 1, handleId: "real-restart", chatSessionId: "restart-chat", capabilityId: "terminal.execute", terminalSessionId: "terminal-one", totalChars: 14, storedChars: 14, sourceTruncated: false, preview: "across restart", storedAt: now, accessedAt: now },',
    '      content: "across restart",',
    '    });',
    '    await handlers.get("netcatty:tempdir:toolOutputWrite")({}, {',
    '      record: { schemaVersion: 1, handleId: "real-restart-two", chatSessionId: "restart-chat", capabilityId: "terminal.execute", terminalSessionId: "terminal-two", totalChars: 13, storedChars: 13, sourceTruncated: false, preview: "second output", storedAt: now, accessedAt: now },',
    '      content: "second output",',
    '    });',
    '    console.log(`RESULT:${JSON.stringify(saved)}`);',
    '    return;',
    '  }',
    '  if (process.env.PHASE === "delete-terminal") {',
    '    const deleted = await handlers.get("netcatty:tempdir:toolOutputDeleteTerminal")({}, { terminalSessionId: "terminal-one" });',
    '    console.log(`RESULT:${JSON.stringify(deleted)}`);',
    '    return;',
    '  }',
    '  if (process.env.PHASE === "delete-chat") {',
    '    const deleted = await handlers.get("netcatty:tempdir:toolOutputDeleteSession")({}, { chatSessionId: "restart-chat" });',
    '    console.log(`RESULT:${JSON.stringify(deleted)}`);',
    '    return;',
    '  }',
    '  if (process.env.PHASE === "clear") {',
    '    const cleared = await handlers.get("netcatty:tempdir:clear")();',
    '    const status = await handlers.get("netcatty:tempdir:toolOutputPersistenceStatus")();',
    '    console.log(`RESULT:${JSON.stringify({ cleared, status })}`);',
    '    return;',
    '  }',
    '  if (process.env.PHASE === "unlock") {',
    '    const locked = await handlers.get("netcatty:tempdir:toolOutputPersistenceStatus")();',
    '    keychainLocked = false;',
    '    const unlocked = await handlers.get("netcatty:tempdir:toolOutputPersistenceStatus")();',
    '    const restored = await handlers.get("netcatty:tempdir:toolOutputRestore")({}, { handleId: "real-restart", chatSessionId: "restart-chat" });',
    '    const content = restored ? await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: restored.path }) : null;',
    '    console.log(`RESULT:${JSON.stringify({ locked, unlocked, content })}`);',
    '    return;',
    '  }',
    '  const restored = await handlers.get("netcatty:tempdir:toolOutputRestore")({}, { handleId: "real-restart", chatSessionId: "restart-chat" });',
    '  const content = restored ? await handlers.get("netcatty:tempdir:toolOutputRead")({}, { path: restored.path }) : null;',
    '  await bridge.cleanupExpiredToolOutputFiles();',
    '  console.log(`RESULT:${JSON.stringify({ restored: Boolean(restored), content })}`);',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join("\n");
  const run = (phase, secret) => spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, "../.."),
    env: isolatedTempChildEnv(root, fakeHome, {
      PHASE: phase,
      FAKE_SAFE_STORAGE_SECRET: secret,
    }),
    encoding: "utf8",
  });
  try {
    const written = run("write", "stable-secret");
    assert.equal(written.status, 0, written.stderr || written.stdout);
    assert.match(written.stdout, /RESULT:.*"ok":true/);

    const reopened = run("read", "stable-secret");
    assert.equal(reopened.status, 0, reopened.stderr || reopened.stdout);
    assert.match(reopened.stdout, /RESULT:.*"restored":true.*"content":"across restart"/);

    const unlocked = run("unlock", "stable-secret");
    assert.equal(unlocked.status, 0, unlocked.stderr || unlocked.stdout);
    assert.match(unlocked.stdout, /RESULT:.*"locked":\{"durable":false.*"unlocked":\{"durable":true\}.*"content":"across restart"/);

    const persistedDir = path.join(root, "Netcatty");
    const signingKeyPath = path.join(persistedDir, ".tool-output-signing-key");
    const signingKeyBeforeFailure = await fs.promises.readFile(signingKeyPath);
    const old = new Date(Date.now() - 31 * 60 * 1_000);
    for (const file of await fs.promises.readdir(persistedDir)) {
      if (file.endsWith(".log") || file.endsWith(".log.meta.json")) {
        await fs.promises.utimes(path.join(persistedDir, file), old, old);
      }
    }
    const wrongKey = run("read", "different-secret");
    assert.equal(wrongKey.status, 0, wrongKey.stderr || wrongKey.stdout);
    assert.match(wrongKey.stdout, /RESULT:\{"restored":false,"content":null\}/);
    assert.deepEqual(await fs.promises.readFile(signingKeyPath), signingKeyBeforeFailure);
    const remainingFiles = await fs.promises.readdir(persistedDir);
    assert.equal(remainingFiles.filter(file => file.endsWith(".log")).length, 2);
    assert.equal(remainingFiles.filter(file => file.endsWith(".log.meta.json")).length, 2);

    const recoveredRead = run("read", "stable-secret");
    assert.equal(recoveredRead.status, 0, recoveredRead.stderr || recoveredRead.stdout);
    assert.match(recoveredRead.stdout, /RESULT:.*"restored":true.*"content":"across restart"/);

    const reset = run("clear", "different-secret");
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    assert.match(reset.stdout, /RESULT:.*"status":\{"durable":true\}/);
    assert.notDeepEqual(await fs.promises.readFile(signingKeyPath), signingKeyBeforeFailure);

    const rewritten = run("write", "different-secret");
    assert.equal(rewritten.status, 0, rewritten.stderr || rewritten.stdout);
    assert.match(rewritten.stdout, /RESULT:.*"ok":true/);

    const deletedTerminal = run("delete-terminal", "different-secret");
    assert.equal(deletedTerminal.status, 0, deletedTerminal.stderr || deletedTerminal.stdout);
    assert.match(deletedTerminal.stdout, /RESULT:\{"deletedCount":1\}/);
    const afterTerminalDelete = await fs.promises.readdir(persistedDir);
    assert.equal(afterTerminalDelete.filter(file => file.endsWith(".log")).length, 1);

    const deletedChat = run("delete-chat", "different-secret");
    assert.equal(deletedChat.status, 0, deletedChat.stderr || deletedChat.stdout);
    assert.match(deletedChat.stdout, /RESULT:\{"deletedCount":1\}/);
    const afterChatDelete = await fs.promises.readdir(persistedDir);
    assert.equal(afterChatDelete.some(file => file.endsWith(".log") || file.endsWith(".log.meta.json")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("tool output persistence reports when secure storage is unavailable", async () => {
  const handlers = new Map();
  tempDirBridge.registerHandlers(
    { handle(channel, handler) { handlers.set(channel, handler); } },
    undefined,
    { safeStorage: { isEncryptionAvailable: () => false } },
  );

  assert.deepEqual(
    await handlers.get("netcatty:tempdir:toolOutputPersistenceStatus")(),
    { durable: false, reason: "Secure local storage is unavailable." },
  );
});

test("Linux basic_text and unknown backends are not treated as secure storage", () => {
  const storage = backend => ({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
  });

  assert.equal(tempDirBridge.isSecureToolOutputStorageAvailable(storage("basic_text"), "linux"), false);
  assert.equal(tempDirBridge.isSecureToolOutputStorageAvailable(storage("unknown"), "linux"), false);
  assert.equal(tempDirBridge.isSecureToolOutputStorageAvailable(storage("gnome_libsecret"), "linux"), true);
  assert.equal(tempDirBridge.isSecureToolOutputStorageAvailable(storage("basic_text"), "darwin"), true);
});
