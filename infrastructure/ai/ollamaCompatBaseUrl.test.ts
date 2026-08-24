import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOllamaSdkBaseURL } from "./ollamaCompatBaseUrl";

test("normalizeOllamaSdkBaseURL appends /v1 to the Cloud origin only", () => {
  assert.equal(normalizeOllamaSdkBaseURL("https://ollama.com"), "https://ollama.com/v1");
  assert.equal(normalizeOllamaSdkBaseURL("https://ollama.com/"), "https://ollama.com/v1");
  assert.equal(normalizeOllamaSdkBaseURL("HTTP://OLLAMA.COM"), "HTTP://OLLAMA.COM/v1");
  assert.equal(normalizeOllamaSdkBaseURL("https://ollama.com/v1"), "https://ollama.com/v1");
  assert.equal(normalizeOllamaSdkBaseURL("https://ollama.com/v1/"), "https://ollama.com/v1");
  assert.equal(normalizeOllamaSdkBaseURL("https://ollama.com/api"), "https://ollama.com/v1");
  assert.equal(normalizeOllamaSdkBaseURL("https://ollama.com/api/"), "https://ollama.com/v1");
  assert.equal(normalizeOllamaSdkBaseURL("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(normalizeOllamaSdkBaseURL("http://192.168.1.10:11434/v1"), "http://192.168.1.10:11434/v1");
});
