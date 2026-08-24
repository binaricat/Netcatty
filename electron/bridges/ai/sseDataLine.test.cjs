const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSseDataPayload } = require("./sseDataLine.cjs");

test("extractSseDataPayload accepts data: with or without the optional space", () => {
  assert.equal(extractSseDataPayload('data: {"a":1}'), '{"a":1}');
  assert.equal(extractSseDataPayload('data:{"a":1}'), '{"a":1}');
  assert.equal(extractSseDataPayload('  data:{"a":1}  \r'), '{"a":1}');
  assert.equal(extractSseDataPayload("data: [DONE]"), "[DONE]");
  assert.equal(extractSseDataPayload("data:[DONE]"), "[DONE]");
});

test("extractSseDataPayload strips only one leading space after the colon", () => {
  assert.equal(extractSseDataPayload("data:  keep"), " keep");
  assert.equal(extractSseDataPayload("data:"), "");
  assert.equal(extractSseDataPayload("data: "), "");
});

test("extractSseDataPayload ignores non-data SSE lines", () => {
  assert.equal(extractSseDataPayload(""), null);
  assert.equal(extractSseDataPayload(": comment"), null);
  assert.equal(extractSseDataPayload("event: message"), null);
  assert.equal(extractSseDataPayload("DATA: foo"), null);
  assert.equal(extractSseDataPayload(null), null);
  assert.equal(extractSseDataPayload(undefined), null);
});
