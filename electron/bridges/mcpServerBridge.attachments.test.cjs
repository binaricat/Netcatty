const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("./mcpServerBridge.cjs");

test("registered chat attachments can be listed and read by path or filename", async (t) => {
  t.after(() => bridge.cleanup());

  bridge.updateAttachmentMetadata([
    {
      filename: "note.txt",
      mediaType: "text/plain",
      filePath: "/tmp/netcatty-note.txt",
      base64Data: Buffer.from("hello attachment").toString("base64"),
    },
  ], "chat-a");

  const listed = bridge.handleListAttachments({ chatSessionId: "chat-a" });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.attachments, [{
    filename: "note.txt",
    mediaType: "text/plain",
    filePath: "/tmp/netcatty-note.txt",
    sizeBytes: 16,
  }]);

  const byPath = bridge.handleReadAttachment({
    chatSessionId: "chat-a",
    filePath: "/tmp/netcatty-note.txt",
  });
  assert.equal(byPath.ok, true);
  assert.equal(byPath.text, "hello attachment");

  const byName = bridge.handleReadAttachment({
    chatSessionId: "chat-a",
    filename: "note.txt",
  });
  assert.equal(byName.ok, true);
  assert.equal(byName.base64Data, Buffer.from("hello attachment").toString("base64"));
});

test("attachment reads enforce a size limit for disk-backed files", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-attachment-limit-"));
  const filePath = path.join(dir, "large.md");
  const emptyPath = path.join(dir, "empty.md");
  fs.writeFileSync(filePath, "# Notes\n".repeat(200));
  fs.writeFileSync(emptyPath, "");
  t.after(() => {
    bridge.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  bridge.updateAttachmentMetadata([
    { filename: "large.md", mediaType: "text/markdown", filePath },
    { filename: "empty.md", mediaType: "text/markdown", filePath: emptyPath },
  ], "chat-a");

  assert.equal(bridge.handleListAttachments({ chatSessionId: "chat-a" }).attachments[0].sizeBytes, undefined);
  assert.match(
    bridge.handleReadAttachment({ chatSessionId: "chat-a", filename: "large.md", maxBytes: 100 }).error,
    /size limit/,
  );
  const empty = bridge.handleReadAttachment({ chatSessionId: "chat-a", filename: "empty.md", maxBytes: 100 });
  assert.equal(empty.ok, true);
  assert.equal(empty.text, "");
});

test("attachment reads reject unregistered local paths", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-attachment-test-"));
  const secretPath = path.join(dir, "secret.txt");
  fs.writeFileSync(secretPath, "secret");
  t.after(() => {
    bridge.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  bridge.updateAttachmentMetadata([
    {
      filename: "allowed.txt",
      mediaType: "text/plain",
      filePath: path.join(dir, "allowed.txt"),
      base64Data: Buffer.from("allowed").toString("base64"),
    },
  ], "chat-a");

  const result = bridge.handleReadAttachment({
    chatSessionId: "chat-a",
    filePath: secretPath,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not registered/i);
});
