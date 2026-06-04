const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSdkTurnPrompt, resolveBackendKey } = require("./sdkStreamHandlers.cjs");

test("resolveBackendKey maps backend command/value to registry key", () => {
  assert.equal(resolveBackendKey("claude"), "claude");
  assert.equal(resolveBackendKey("codex"), "codex");
  assert.equal(resolveBackendKey("copilot"), "copilot");
});

test("resolveBackendKey returns null for unknown", () => {
  assert.equal(resolveBackendKey("claude-agent-acp"), null);
  assert.equal(resolveBackendKey(""), null);
  assert.equal(resolveBackendKey(undefined), null);
});

test("buildSdkTurnPrompt replays history only when requested", () => {
  const prompt = buildSdkTurnPrompt({
    prompt: "latest question",
    replayHistory: true,
    historyMessages: [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ],
  });

  assert.match(prompt, /Conversation context replay/);
  assert.match(prompt, /USER: previous question/);
  assert.match(prompt, /ASSISTANT: previous answer/);
  assert.match(prompt, /latest question$/);

  const steadyStatePrompt = buildSdkTurnPrompt({
    prompt: "latest question",
    replayHistory: false,
    historyMessages: [{ role: "user", content: "previous question" }],
  });
  assert.equal(steadyStatePrompt, "latest question");
});

test("buildSdkTurnPrompt stages attachments as local file hints", () => {
  const staged = [];
  const prompt = buildSdkTurnPrompt({
    prompt: "describe it",
    attachments: [
      { base64Data: Buffer.from("img").toString("base64"), mediaType: "image/png", filename: "screen.png" },
    ],
    writeAttachmentToTemp: (attachment) => `/tmp/${attachment.filename}`,
    onStagedAttachment: (attachment) => staged.push(attachment),
  });

  assert.match(prompt, /Attached files/);
  assert.match(prompt, /read_attachment/);
  assert.match(prompt, /"screen\.png" \(image\/png\)/);
  assert.match(prompt, /\/tmp\/screen\.png/);
  assert.match(prompt, /describe it$/);
  assert.deepEqual(staged, [{
    filename: "screen.png",
    mediaType: "image/png",
    filePath: "/tmp/screen.png",
    base64Data: Buffer.from("img").toString("base64"),
  }]);
});
