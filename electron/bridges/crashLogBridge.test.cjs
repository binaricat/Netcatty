"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_LOG_FILE_BYTES,
  MAX_LOG_ENTRY_BYTES,
  appendEntryLine,
  boundedText,
  serializeEntry,
  truncateFileToTail,
} = require("./crashLogBridge.cjs").__internals;

// Creates a unique temp directory for one test and registers teardown on the
// test context so large fixture files never outlive the run.
function tmpFile(t, name = "crash-2026-10-10.log") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-crashlog-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });
  return { dir, filePath: path.join(dir, name) };
}

function entryLine(padLen = 0) {
  return JSON.stringify({
    timestamp: "2026-10-10T00:00:00.000Z",
    source: "test",
    message: "boom",
    ...(padLen > 0 ? { pad: "p".repeat(padLen) } : {}),
  });
}

test("appendEntryLine stops accepting entries once the per-day file reaches the size cap", (t) => {
  const { filePath } = tmpFile(t);

  assert.equal(appendEntryLine(filePath, entryLine()), true, "first entry written");
  assert.equal(
    appendEntryLine(filePath, "x".repeat(MAX_LOG_ENTRY_BYTES)),
    false,
    "oversized entry rejected",
  );

  // Pad the file to exactly the cap, then confirm further writes are dropped.
  const filler = entryLine();
  // A padded line costs (filler.length + 10 + padLen) bytes; pad so the file
  // lands within ~10 bytes of MAX_LOG_FILE_BYTES, leaving no room for the
  // 50-byte filler entry that follows.
  const padLen =
    MAX_LOG_FILE_BYTES -
    fs.statSync(filePath).size -
    (filler.length + 20);
  fs.appendFileSync(filePath, entryLine(padLen) + "\n");
  const sizeBefore = fs.statSync(filePath).size;
  assert.ok(
    sizeBefore <= MAX_LOG_FILE_BYTES && sizeBefore > MAX_LOG_FILE_BYTES - 20,
    `size ${sizeBefore} should sit just under the cap`,
  );

  assert.equal(appendEntryLine(filePath, filler), false, "write that would exceed cap is dropped");
  assert.equal(fs.statSync(filePath).size, sizeBefore, "file did not grow");
});

test("serializeEntry keeps serialized lines bounded even for huge extras", () => {
  const huge = { blob: "z".repeat(40 * 1024 * 1024) };
  const line = serializeEntry({
    timestamp: "2026-10-10T00:00:00.000Z",
    source: "test",
    message: "boom",
    stack: new Error("boom").stack,
    extra: huge,
  });
  assert.ok(line.length <= MAX_LOG_ENTRY_BYTES, `line length ${line.length} exceeds cap`);
  const entry = JSON.parse(line);
  assert.equal(entry.source, "test");
  assert.equal(entry.message, "boom");
});

test("boundedText truncates long strings and leaves short ones alone", () => {
  assert.equal(boundedText("short", 100), "short");
  const cut = boundedText("a".repeat(5000), 4096);
  assert.equal(cut.length, 4096 + " ... [truncated]".length);
  assert.ok(cut.startsWith("a".repeat(4096)));
  assert.ok(cut.endsWith("[truncated]"));
});

test("truncateFileToTail trims oversized files to their last lines", (t) => {
  const { filePath } = tmpFile(t);

  // Simulate a pathological file like issue #3626's 149.7 GB log by writing
  // a ~17 MB file of valid JSONL lines (each ~16 KB), then trimming.
  const line = entryLine(16 * 1024);
  let content = "";
  while (content.length < MAX_LOG_FILE_BYTES + 1024 * 1024) content += line + "\n";
  fs.appendFileSync(filePath, content);
  assert.ok(fs.statSync(filePath).size > MAX_LOG_FILE_BYTES);

  assert.equal(truncateFileToTail(filePath, MAX_LOG_FILE_BYTES), true);
  const newSize = fs.statSync(filePath).size;
  assert.ok(newSize <= MAX_LOG_FILE_BYTES, `trimmed size ${newSize} exceeds cap`);

  // Every remaining line must be a complete, parseable JSONL entry.
  const remaining = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  assert.ok(remaining.length > 0);
  for (const l of remaining) assert.doesNotThrow(() => JSON.parse(l));

  // Files under the cap are left untouched.
  assert.equal(truncateFileToTail(filePath, MAX_LOG_FILE_BYTES), false);
});

test("truncateFileToTail tolerates a tail with no newline and missing files", (t) => {
  const { dir, filePath } = tmpFile(t);

  // Missing file
  assert.equal(truncateFileToTail(path.join(dir, "crash-2026-01-01.log"), MAX_LOG_FILE_BYTES), false);

  // Oversized tail with a single unterminated giant line: keeps at most maxBytes.
  fs.appendFileSync(filePath, "g".repeat(MAX_LOG_FILE_BYTES + 4096));
  assert.equal(truncateFileToTail(filePath, MAX_LOG_FILE_BYTES), true);
  assert.ok(fs.statSync(filePath).size <= MAX_LOG_FILE_BYTES);
});
