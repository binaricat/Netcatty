const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("./aiSessionsBackupBridge.cjs");
const session = { id: "s1", title: "Session", agentId: "agent", scope: { type: "global" }, messages: [], updatedAt: 1 };

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ai-backup-"));
}

test("writeGeneration writes atomically and rotates generations to the cap", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const { MAX_GENERATIONS } = bridge.__internals;
    for (let i = 0; i < MAX_GENERATIONS + 2; i++) {
      const result = await bridge.__internals.writeGeneration(JSON.stringify({ gen: i }));
      assert.equal(result.ok, true);
      // Small delay so timestamped names strictly increase.
      const stamp = bridge.__internals.timestampToken();
      while (bridge.__internals.timestampToken() === stamp) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    const generations = bridge.__internals.listGenerationFiles(dir);
    assert.equal(generations.length, MAX_GENERATIONS);
    // Newest generation wins the lexicographic sort.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, generations[0]), "utf-8")), {
      gen: MAX_GENERATIONS + 1,
    });
    // No temp files left behind by the atomic write.
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips corrupt generations and reads the newest parseable one", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    fs.writeFileSync(path.join(dir, "ai-sessions-20260101T000000-000Z.json"), "not json");
    fs.writeFileSync(
      path.join(dir, "ai-sessions-20260102T000000-000Z.json"),
      JSON.stringify([session]),
    );
    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.deepEqual(JSON.parse(latest.json), [session]);
    // A corrupt-only directory reports failure instead of throwing.
    const corruptOnly = makeTempDir();
    bridge.__internals._setBackupDir(corruptOnly);
    try {
      fs.writeFileSync(path.join(corruptOnly, "ai-sessions-20260103T000000-000Z.json"), "{oops");
      assert.equal(bridge.__internals.readLatestGeneration().ok, false);
    } finally {
      bridge.__internals._setBackupDir(dir);
      fs.rmSync(corruptOnly, { recursive: true, force: true });
    }
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips non-array generations", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const olderFile = "ai-sessions-20260101T000000-000Z.json";
    const sessions = [session];
    fs.writeFileSync(path.join(dir, olderFile), JSON.stringify(sessions));
    fs.writeFileSync(path.join(dir, "ai-sessions-20260102T000000-000Z.json"), JSON.stringify({ sessions }));

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, olderFile);
    assert.deepEqual(JSON.parse(latest.json), sessions);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips arrays without usable sessions", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const olderFile = "ai-sessions-20260101T000000-000Z.json";
    fs.writeFileSync(path.join(dir, olderFile), JSON.stringify([session]));
    fs.writeFileSync(path.join(dir, "ai-sessions-20260102T000000-000Z.json"), JSON.stringify([{ id: "bad" }]));

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, olderFile);
    assert.deepEqual(JSON.parse(latest.json), [session]);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration treats an empty generation as an authoritative wipe", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const newestFile = "ai-sessions-20260102T000000-000Z.json";
    fs.writeFileSync(path.join(dir, "ai-sessions-20260101T000000-000Z.json"), JSON.stringify([session]));
    fs.writeFileSync(path.join(dir, newestFile), "[]");

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, newestFile);
    assert.deepEqual(JSON.parse(latest.json), []);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips sessions with malformed messages", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const olderFile = "ai-sessions-20260101T000000-000Z.json";
    const newestFile = "ai-sessions-20260102T000000-000Z.json";
    fs.writeFileSync(path.join(dir, olderFile), JSON.stringify([session]));
    for (const message of [null, {}, { id: "m", role: "user", content: "hello", timestamp: null }]) {
      fs.writeFileSync(path.join(dir, newestFile), JSON.stringify([{ ...session, messages: [message] }]));
      const latest = bridge.__internals.readLatestGeneration();
      assert.equal(latest.ok, true);
      assert.equal(latest.file, olderFile);
      assert.deepEqual(JSON.parse(latest.json), [session]);
    }
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGeneration rejects invalid or oversized payloads", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    assert.equal((await bridge.__internals.writeGeneration("")).ok, false);
    assert.equal((await bridge.__internals.writeGeneration(null)).ok, false);
    const oversized = "x".repeat(bridge.__internals.MAX_BACKUP_JSON_BYTES + 1);
    assert.equal((await bridge.__internals.writeGeneration(oversized)).ok, false);
    assert.deepEqual(bridge.__internals.listGenerationFiles(dir), []);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export falls back to a fixed path when no dialog is available", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const result = await bridge.__internals.writeExportFixed(dir, JSON.stringify([{ id: "s1" }]));
    assert.equal(result.success, true);
    assert.ok(path.basename(result.filePath).startsWith("export-"));
    assert.equal(fs.existsSync(result.filePath), true);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGeneration serializes concurrent writes without leaving temp files", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const results = await Promise.all([
      bridge.__internals.writeGeneration(JSON.stringify({ gen: "a" })),
      bridge.__internals.writeGeneration(""),
      bridge.__internals.writeGeneration(JSON.stringify({ gen: "b" })),
    ]);
    assert.deepEqual(results.map((result) => result.ok), [true, false, true]);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    const newest = bridge.__internals.listGenerationFiles(dir)[0];
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, newest), "utf-8")), { gen: "b" });
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
