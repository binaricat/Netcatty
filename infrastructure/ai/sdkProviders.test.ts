import assert from "node:assert/strict";
import test from "node:test";
import { generateText, streamText } from "ai";
import { buildCattySdkMessages, createContinuationContext } from "./harness/turnDrivers/cattyMessageBuilder";
import { ToolOutputStore } from "./harness/toolOutputStore";

import { createModelFromConfig, isStreamingRequest, resolveProviderEndpoint } from "./sdk/providers";
import { OPENCODE_CLIENT_USER_AGENT } from "./providerRequestHeaders";
import type { ProviderConfig } from "./types";

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p",
    providerId: "custom",
    name: "Test",
    enabled: true,
    defaultModel: "m",
    ...overrides,
  };
}

test("createModelFromConfig routes by explicit style: anthropic on top of custom providerId", () => {
  const model = createModelFromConfig(makeConfig({ style: "anthropic", defaultModel: "claude-3-5-sonnet" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^anthropic/);
  assert.equal((model as { modelId?: string }).modelId, "claude-3-5-sonnet");
});

test("createModelFromConfig routes by explicit style: google on top of custom providerId", () => {
  const model = createModelFromConfig(makeConfig({ style: "google", defaultModel: "gemini-2.0-flash" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^google/);
});

test("createModelFromConfig defaults legacy custom providerId to the OpenAI-compatible client", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "custom", defaultModel: "gpt-4o" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^openai\.chat/);
});

test("createModelFromConfig keeps Chat Completions as the OpenAI default", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "openai", defaultModel: "gpt-4o" }));
  assert.equal((model as { provider?: string }).provider, "openai.chat");
});

test("createModelFromConfig uses Responses API when openaiApi is responses", () => {
  const model = createModelFromConfig(makeConfig({
    providerId: "openai",
    defaultModel: "gpt-4o",
    openaiApi: "responses",
  }));
  assert.equal((model as { provider?: string }).provider, "openai.responses");
});

test("createModelFromConfig ignores openaiApi when style is not openai", () => {
  const model = createModelFromConfig(makeConfig({
    style: "anthropic",
    openaiApi: "responses",
    defaultModel: "claude",
  }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^anthropic/);
});

test("createModelFromConfig keeps the Anthropic providerId fallback when style is unset", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "anthropic", defaultModel: "claude" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^anthropic/);
});

test("createModelFromConfig keeps the Google providerId fallback when style is unset", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "google", defaultModel: "gemini" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^google/);
});

test("createModelFromConfig keeps ollama's baseURL fallback and disposable apiKey", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "ollama", defaultModel: "llama3" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^openai/);
  // Ollama leaves URL building to the SDK, but we can at least confirm it's still treated as OpenAI-style.
});

test("resolveProviderEndpoint applies the openrouter URL fallback for every style override", () => {
  // Regression for codex feedback on #1105: gating the fallback on
  // style === 'openai' silently misrouted traffic away from openrouter.ai
  // when users overrode the wire format.
  for (const style of ["openai", "anthropic", "google"] as const) {
    const result = resolveProviderEndpoint(
      { id: "p", providerId: "openrouter", name: "OR", enabled: true },
      style,
      "sk-test",
    );
    assert.equal(result.baseURL, "https://openrouter.ai/api/v1", `style=${style} should still hit openrouter.ai`);
  }
});

test("resolveProviderEndpoint keeps an explicit openrouter baseURL untouched", () => {
  const result = resolveProviderEndpoint(
    { id: "p", providerId: "openrouter", name: "OR", enabled: true, baseURL: "https://proxy.example/v1" },
    "anthropic",
    "sk-test",
  );
  assert.equal(result.baseURL, "https://proxy.example/v1");
});

test("resolveProviderEndpoint routes OpenCode Go models to their native gateway prefix", () => {
  const base = {
    id: "ocg",
    providerId: "opencode-go" as const,
    name: "OpenCode Go",
    enabled: true,
    baseURL: "https://opencode.ai/inference/go/openai/v1",
  };
  assert.equal(
    resolveProviderEndpoint({ ...base, defaultModel: "kimi-k3" }, "openai", "key").baseURL,
    "https://opencode.ai/inference/go/openai/v1",
  );
  assert.equal(
    resolveProviderEndpoint({ ...base, defaultModel: "grok-4.7" }, "openai", "key").baseURL,
    "https://opencode.ai/inference/go/openai/v1",
  );
  assert.equal(
    resolveProviderEndpoint({ ...base, defaultModel: "qwen3.8-max" }, "anthropic", "key").baseURL,
    "https://opencode.ai/inference/go/anthropic/v1",
  );
  assert.equal(
    resolveProviderEndpoint({ ...base, defaultModel: "gemini-4-argon" }, "google", "key").baseURL,
    "https://opencode.ai/inference/go/google/v1beta",
  );
});

test("createModelFromConfig uses each OpenCode Go model's native SDK", () => {
  const base = {
    providerId: "opencode-go" as const,
    baseURL: "https://opencode.ai/inference/go/openai/v1",
  };
  assert.equal(
    (createModelFromConfig(makeConfig({ ...base, defaultModel: "kimi-k3" })) as { provider?: string }).provider,
    "openai.chat",
  );
  assert.equal(
    (createModelFromConfig(makeConfig({ ...base, defaultModel: "grok-4.7" })) as { provider?: string }).provider,
    "openai.responses",
  );
  assert.match(
    String((createModelFromConfig(makeConfig({ ...base, defaultModel: "qwen3.8-max" })) as { provider?: string }).provider ?? ""),
    /^anthropic/,
  );
  assert.match(
    String((createModelFromConfig(makeConfig({ ...base, defaultModel: "gemini-4-argon" })) as { provider?: string }).provider ?? ""),
    /^google/,
  );
});

test("resolveProviderEndpoint normalizes Anthropic-compat Base URL for @ai-sdk/anthropic", () => {
  // Claude Code style (bare host) must gain /v1 so chat hits …/v1/messages.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "anthropic", baseURL: "https://gateway.example/" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://gateway.example/v1",
  );
  // AI SDK style already includes /v1 — leave it alone.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "anthropic", baseURL: "https://gateway.example/v1" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://gateway.example/v1",
  );
  // Official Anthropic preset default (no /v1) also needs the suffix.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ providerId: "anthropic", baseURL: "https://api.anthropic.com" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://api.anthropic.com/v1",
  );
  // Custom complete SDK prefix without /v1 must not gain /v1
  // (proxy serves …/anthropic/messages, not …/anthropic/v1/messages).
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "anthropic", baseURL: "https://proxy.example/anthropic" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://proxy.example/anthropic",
  );
  // OpenAI-compat style must not rewrite the path.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "openai", baseURL: "https://api.deepseek.com" }),
      "openai",
      "sk-test",
    ).baseURL,
    "https://api.deepseek.com",
  );
});
test("resolveProviderEndpoint applies the ollama URL fallback for every style override", () => {
  for (const style of ["openai", "anthropic", "google"] as const) {
    const result = resolveProviderEndpoint(
      { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
      style,
      undefined,
    );
    assert.equal(result.baseURL, "http://localhost:11434/v1", `style=${style} should still hit localhost ollama`);
  }
});

test("resolveProviderEndpoint only swaps in the literal 'ollama' apiKey when no key is configured", () => {
  const local = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "openai",
    undefined,
  );
  assert.equal(local.apiKey, "ollama");

  // Cloud / any configured key must keep the IPC placeholder so the main
  // process can inject the decrypted key. Overwriting it with 'ollama'
  // produced Authorization: Bearer ollama and 401s against ollama.com.
  const cloud = resolveProviderEndpoint(
    {
      id: "p",
      providerId: "ollama",
      name: "Ollama",
      enabled: true,
      baseURL: "https://ollama.com/v1",
    },
    "openai",
    "__IPC_SECURED__",
  );
  assert.equal(cloud.apiKey, "__IPC_SECURED__");
  assert.equal(cloud.baseURL, "https://ollama.com/v1");

  const anthropic = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "anthropic",
    "PLACEHOLDER",
  );
  assert.equal(anthropic.apiKey, "PLACEHOLDER");

  const empty = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "openai",
    "",
  );
  assert.equal(empty.apiKey, "ollama");
});

test("resolveProviderEndpoint adds /v1 to a bare ollama.com Cloud host", () => {
  assert.equal(
    resolveProviderEndpoint(
      {
        id: "p",
        providerId: "ollama",
        name: "Ollama",
        enabled: true,
        baseURL: "https://ollama.com",
      },
      "openai",
      "__IPC_SECURED__",
    ).baseURL,
    "https://ollama.com/v1",
  );
  assert.equal(
    resolveProviderEndpoint(
      {
        id: "p",
        providerId: "ollama",
        name: "Ollama",
        enabled: true,
        baseURL: "https://ollama.com/",
      },
      "openai",
      "__IPC_SECURED__",
    ).baseURL,
    "https://ollama.com/v1",
  );
  assert.equal(
    resolveProviderEndpoint(
      {
        id: "p",
        providerId: "ollama",
        name: "Ollama",
        enabled: true,
        baseURL: "https://ollama.com/api",
      },
      "openai",
      "__IPC_SECURED__",
    ).baseURL,
    "https://ollama.com/v1",
  );
});

// Exercise the real SDK request builders through the Electron fetch boundary.
// A rejected request is sufficient here: headers are inspected before parsing.
test("SDK requests forward custom headers and scope OpenCode sessions", async (t) => {
  const browserGlobal = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = browserGlobal.window;
  t.after(() => { browserGlobal.window = originalWindow; });
  const requests: Array<{ url: string; headers: Headers }> = [];
  browserGlobal.window = {
    netcatty: {
      aiFetch: async (url: string, _method: string, headers: Record<string, string>) => {
        requests.push({ url, headers: new Headers(headers) });
        return { ok: false, status: 400, data: '{"error":{"message":"test response"}}' };
      },
    },
  };

  for (const style of ["openai", "anthropic", "google"] as const) {
    for (const openaiApi of style === "openai" ? ["chat", "responses"] as const : ["chat"] as const) {
      for (const sessionId of ["conversation-a", "conversation-a", "conversation-b"]) {
        const model = createModelFromConfig(makeConfig({
          style,
          openaiApi,
          apiKey: "test-key",
          baseURL: "https://opencode.ai/zen/go/v1",
          customHeaders: { "X-Test-Header": "configured" },
        }), { chatSessionId: sessionId });
        await assert.rejects(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }));
        const request = requests.at(-1)!;
        assert.equal(request.headers.get("x-opencode-session"), sessionId);
        assert.ok((request.headers.get("user-agent") ?? "").startsWith(OPENCODE_CLIENT_USER_AGENT));
        assert.equal(request.headers.get("x-test-header"), "configured");
      }
    }
  }
  for (const baseURL of ["https://opencode.ai/zen/go/v1", "https://example.test/v1"]) {
    for (const customHeaders of [undefined, { "X-OpenCode-Session": "override" }]) {
      const model = createModelFromConfig(makeConfig({ baseURL, apiKey: "test-key", customHeaders }), { chatSessionId: "automatic" });
      await assert.rejects(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }));
      assert.equal(requests.at(-1)!.headers.get("x-opencode-session"),
        customHeaders ? "override" : baseURL.includes("opencode.ai") ? "automatic" : null);
    }
  }
  assert.equal(requests.length, 16);
});

test("OpenAI Chat sends inline image attachments as data URLs through the bridge", async (t) => {
  const browserGlobal = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = browserGlobal.window;
  t.after(() => { browserGlobal.window = originalWindow; });
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  Reflect.set(globalThis, "window", { netcatty: {
    aiFetch: async (url: string, _method: string, _headers: Record<string, string>, body: string) => {
      requests.push({ url, body: JSON.parse(body) });
      return { ok: false, status: 400, data: '{"error":{"message":"captured request"}}' };
    },
    aiChatStream: async (_requestId: string, url: string, _headers: Record<string, string>, body: string) => {
      requests.push({ url, body: JSON.parse(body) });
      return { ok: false, error: "captured request" };
    },
    onAiStreamData: () => () => {},
    onAiStreamEnd: () => () => {},
    onAiStreamError: () => () => {},
  } });

  for (const [mediaType, base64Data] of [["image/png", "iVBORw0KGgo="], ["image/jpeg", "/9j/4A=="]]) {
    const messages = buildCattySdkMessages({
      allMessages: [], includeCurrentUserMessage: true, trimmed: "Read this image",
      attachments: [{ mediaType, base64Data }],
      continuationContext: createContinuationContext("p", "openai", "m", false),
      chatSessionId: "images", toolOutputStore: new ToolOutputStore(), fieldsByMessage: new Map(),
    });
    const model = createModelFromConfig(makeConfig({ openaiApi: "chat", apiKey: "test-key", baseURL: "https://example.test/v1" }));
    await assert.rejects(generateText({ model, messages, maxRetries: 0 }), /captured request/);
    await assert.rejects(async () => await streamText({ model, messages, maxRetries: 0, onError: () => {} }).text);
    for (const request of requests.slice(-2)) {
      assert.equal(request.url, "https://example.test/v1/chat/completions");
      assert.deepEqual(request.body.messages, [{ role: "user", content: [
        { type: "text", text: "Read this image" },
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64Data}` } },
      ] }]);
    }
  }
  assert.equal(requests.length, 4);
});

test("Anthropic SDK sends x-api-key only on official host and adds Bearer on custom bases", async (t) => {
  const browserGlobal = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = browserGlobal.window;
  t.after(() => { browserGlobal.window = originalWindow; });
  const requests: Array<{ url: string; headers: Headers }> = [];
  Reflect.set(globalThis, "window", {
    netcatty: {
      aiFetch: async (url: string, _method: string, headers: Record<string, string>) => {
        requests.push({ url, headers: new Headers(headers) });
        return { ok: false, status: 400, data: '{"error":{"message":"captured anthropic request"}}' };
      },
    },
  });

  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

  for (const baseURL of [undefined, "https://api.anthropic.com", "https://api.anthropic.com/v1"]) {
    const model = createModelFromConfig(makeConfig({
      providerId: "anthropic",
      style: "anthropic",
      apiKey: "test-key",
      baseURL,
    }));
    await assert.rejects(async () => await model.doGenerate({ prompt }));
    const request = requests.at(-1)!;
    assert.equal(request.headers.get("x-api-key"), "__IPC_SECURED__");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
  }

  for (const baseURL of [
    "https://ark.cn-beijing.volces.com/api/plan",
    "https://gateway.example/v1",
  ]) {
    const model = createModelFromConfig(makeConfig({
      style: "anthropic",
      apiKey: "test-key",
      baseURL,
    }));
    await assert.rejects(async () => await model.doGenerate({ prompt }));
    const request = requests.at(-1)!;
    assert.equal(request.url, baseURL.endsWith("/api/plan")
      ? baseURL + "/v1/messages"
      : baseURL + "/messages");
    assert.equal(request.headers.get("x-api-key"), "__IPC_SECURED__");
    assert.equal(request.headers.get("authorization"), "Bearer __IPC_SECURED__");
    assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
  }

  const overridden = createModelFromConfig(makeConfig({
    style: "anthropic",
    apiKey: "test-key",
    baseURL: "https://ark.cn-beijing.volces.com/api/plan",
    customHeaders: { Authorization: "Bearer custom-override" },
  }));
  await assert.rejects(async () => await overridden.doGenerate({ prompt }));
  const overriddenReq = requests.at(-1)!;
  assert.equal(overriddenReq.headers.get("x-api-key"), "__IPC_SECURED__");
  assert.equal(overriddenReq.headers.get("authorization"), "Bearer custom-override");

  const overriddenApiKey = createModelFromConfig(makeConfig({
    style: "anthropic",
    apiKey: "test-key",
    baseURL: "https://ark.cn-beijing.volces.com/api/plan",
    customHeaders: { "X-API-Key": "custom-x-api-key" },
  }));
  await assert.rejects(async () => await overriddenApiKey.doGenerate({ prompt }));
  const overriddenApiKeyReq = requests.at(-1)!;
  assert.equal(overriddenApiKeyReq.headers.get("x-api-key"), "custom-x-api-key");
  assert.equal(overriddenApiKeyReq.headers.get("authorization"), "Bearer __IPC_SECURED__");
});

test("isStreamingRequest recognizes Google SSE endpoints without body stream flag", () => {
  assert.equal(
    isStreamingRequest(
      "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
    true,
  );
  assert.equal(
    isStreamingRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=__IPC_SECURED__",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
    true,
  );
  assert.equal(
    isStreamingRequest(
      "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
    false,
  );
  assert.equal(
    isStreamingRequest(
      "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
    false,
  );
  assert.equal(
    isStreamingRequest(
      "https://opencode.ai/inference/go/openai/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ stream: true }) },
    ),
    true,
  );
});

test("Google SSE requests route through aiChatStream while generateContent stays on aiFetch", async (t) => {
  const browserGlobal = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = browserGlobal.window;
  t.after(() => { browserGlobal.window = originalWindow; });

  const streamCalls: Array<{ requestId: string; url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchCalls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const cancelledRequestIds: string[] = [];
  const dataListeners = new Map<string, (data: string) => void>();
  const endListeners = new Map<string, () => void>();
  let holdStreamOpen = false;

  Reflect.set(globalThis, "window", {
    netcatty: {
      aiFetch: async (url: string, _method: string, headers: Record<string, string>, body: string) => {
        fetchCalls.push({ url, headers: new Headers(headers), body: JSON.parse(body) });
        return {
          ok: true,
          status: 200,
          data: JSON.stringify({
            candidates: [{
              content: { role: "model", parts: [{ text: "non-stream reply" }] },
              finishReason: "STOP",
            }],
          }),
        };
      },
      aiChatStream: async (requestId: string, url: string, headers: Record<string, string>, body: string) => {
        streamCalls.push({ requestId, url, headers: new Headers(headers), body: JSON.parse(body) });
        if (!holdStreamOpen) {
          queueMicrotask(() => {
            dataListeners.get(requestId)?.(JSON.stringify({
              candidates: [{
                content: { role: "model", parts: [{ text: "streamed " }] },
              }],
            }));
            dataListeners.get(requestId)?.(JSON.stringify({
              candidates: [{
                content: { role: "model", parts: [{ text: "reply" }] },
                finishReason: "STOP",
              }],
            }));
            endListeners.get(requestId)?.();
          });
        }
        return { ok: true, statusCode: 200, statusText: "OK" };
      },
      onAiStreamData: (requestId: string, cb: (data: string) => void) => {
        dataListeners.set(requestId, cb);
        return () => { dataListeners.delete(requestId); };
      },
      onAiStreamEnd: (requestId: string, cb: () => void) => {
        endListeners.set(requestId, cb);
        return () => { endListeners.delete(requestId); };
      },
      onAiStreamError: () => () => {},
      aiChatCancel: async (requestId: string) => {
        cancelledRequestIds.push(requestId);
        return true;
      },
    },
  });

  const model = createModelFromConfig(makeConfig({
    providerId: "opencode-go",
    baseURL: "https://opencode.ai/inference/go/openai/v1",
    defaultModel: "gemini-4-argon",
    apiKey: "test-key",
  }), { chatSessionId: "ocg-google-session" });

  // Streaming path -> aiChatStream
  const streamResult = streamText({ model, prompt: "hello", maxRetries: 0 });
  const streamedText = await streamResult.text;
  assert.equal(streamedText, "streamed reply");
  assert.equal(streamCalls.length, 1);
  assert.equal(fetchCalls.length, 0);
  assert.equal(
    streamCalls[0].url,
    "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
  );
  assert.equal(streamCalls[0].body.stream, undefined);
  assert.equal(streamCalls[0].headers.get("x-goog-api-key"), "__IPC_SECURED__");
  assert.equal(streamCalls[0].headers.get("x-opencode-session"), "ocg-google-session");

  // Cancellation on Google SSE stream -> aiChatCancel
  holdStreamOpen = true;
  const abortController = new AbortController();
  const cancelledStream = streamText({
    model,
    prompt: "stop me",
    maxRetries: 0,
    abortSignal: abortController.signal,
    onError: () => {},
  });
  const textPromise = cancelledStream.text;
  await new Promise((resolve) => setTimeout(resolve, 10));
  abortController.abort();
  await assert.rejects(textPromise);
  assert.equal(streamCalls.length, 2);
  assert.deepEqual(cancelledRequestIds, [streamCalls[1].requestId]);

  // Non-streaming path -> aiFetch
  const generated = await generateText({ model, prompt: "hello once", maxRetries: 0 });
  assert.equal(generated.text, "non-stream reply");
  assert.equal(fetchCalls.length, 1);
  assert.equal(streamCalls.length, 2);
  assert.equal(
    fetchCalls[0].url,
    "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent",
  );
});
