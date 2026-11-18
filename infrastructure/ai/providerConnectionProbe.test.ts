import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderProbeUrl,
  classifyProviderProbeResponse,
  probeProviderConnection,
  resolveProviderProbeEndpoint,
  validateProviderProbeInputs,
} from "./providerConnectionProbe";

test("resolveProviderProbeEndpoint follows style conventions including Google /models", () => {
  assert.equal(resolveProviderProbeEndpoint("openai"), "/models");
  assert.equal(resolveProviderProbeEndpoint("anthropic"), "/v1/models");
  assert.equal(resolveProviderProbeEndpoint("google"), "/models");
  assert.equal(resolveProviderProbeEndpoint("openai", "/custom"), "/models");
  assert.equal(resolveProviderProbeEndpoint("google", "/custom/list"), "/models");
});

test("buildProviderProbeUrl joins base URL and endpoint without duplicate slashes", () => {
  assert.equal(
    buildProviderProbeUrl("https://api.deepseek.com/v1/", "/models"),
    "https://api.deepseek.com/v1/models",
  );
  assert.equal(
    buildProviderProbeUrl("https://api.anthropic.com", "/v1/models"),
    "https://api.anthropic.com/v1/models",
  );
});

test("buildProviderProbeUrl avoids double /v1 for AI SDK style Anthropic bases", () => {
  // Reporter case: Base URL already includes /v1 (chat works) but probe used to
  // request GET …/v1/v1/models.
  assert.equal(
    buildProviderProbeUrl("https://gateway.example/v1", "/v1/models"),
    "https://gateway.example/v1/models",
  );
  assert.equal(
    buildProviderProbeUrl("https://gateway.example/v1/", "/v1/models"),
    "https://gateway.example/v1/models",
  );
  assert.equal(
    buildProviderProbeUrl("https://gateway.example/", "/v1/models"),
    "https://gateway.example/v1/models",
  );
});

test("validateProviderProbeInputs requires base URL and API key except for ollama", () => {
  assert.deepEqual(
    validateProviderProbeInputs({ baseURL: "", apiKey: "sk", providerId: "openai" }),
    { ok: false, reason: "missing_base_url" },
  );
  assert.deepEqual(
    validateProviderProbeInputs({ baseURL: "https://api.openai.com/v1", apiKey: "", providerId: "openai" }),
    { ok: false, reason: "missing_api_key" },
  );
  assert.deepEqual(
    validateProviderProbeInputs({ baseURL: "http://localhost:11434/v1", apiKey: "", providerId: "ollama" }),
    { ok: true },
  );
});

test("classifyProviderProbeResponse marks auth and transport failures as error", () => {
  assert.equal(
    classifyProviderProbeResponse({ ok: false, status: 401, latencyMs: 120, error: "Unauthorized" }).health,
    "error",
  );
  assert.equal(
    classifyProviderProbeResponse({ ok: false, status: 0, latencyMs: 30, error: "Request timeout" }).health,
    "error",
  );
});

test("classifyProviderProbeResponse marks 2xx with models payload as ok", () => {
  const result = classifyProviderProbeResponse({
    ok: true,
    status: 200,
    latencyMs: 180,
    data: JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
  });
  assert.equal(result.health, "ok");
  assert.equal(result.latencyMs, 180);
  assert.equal(result.statusCode, 200);
  assert.equal(result.modelCount, 1);
});

test("classifyProviderProbeResponse marks slow or empty success as warn", () => {
  assert.equal(
    classifyProviderProbeResponse({
      ok: true,
      status: 200,
      latencyMs: 4500,
      data: JSON.stringify({ data: [{ id: "m" }] }),
      slowThresholdMs: 3000,
    }).health,
    "warn",
  );
  assert.equal(
    classifyProviderProbeResponse({
      ok: true,
      status: 200,
      latencyMs: 100,
      data: JSON.stringify({ data: [] }),
    }).health,
    "warn",
  );
});

test("classifyProviderProbeResponse accepts Google ListModels name-only entries", () => {
  const result = classifyProviderProbeResponse({
    ok: true,
    status: 200,
    latencyMs: 220,
    data: JSON.stringify({ models: [{ name: "models/gemini-2.0-flash" }] }),
  });
  assert.equal(result.health, "ok");
  assert.equal(result.modelCount, 1);
});

test("probeProviderConnection orchestrates allowlist, headers, fetch, and classification", async () => {
  const calls: Array<{
    url: string;
    method?: string;
    headers?: Record<string, string>;
    skipTLSVerify?: boolean;
  }> = [];
  const allowlist: string[] = [];
  let clock = 1_000;
  const run = await probeProviderConnection({
    bridge: {
      aiAllowlistAddHost: async (baseURL) => {
        allowlist.push(baseURL);
        return { ok: true };
      },
      aiFetch: async (url, method, headers, _body, _providerId, _skipHostCheck, _followRedirects, skipTLSVerify) => {
        calls.push({ url, method, headers, skipTLSVerify });
        return {
          ok: true,
          status: 200,
          data: JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
        };
      },
    },
    baseURL: "https://api.deepseek.com/v1/",
    apiKey: "sk-test",
    providerId: "openai",
    style: "openai",
    skipTLSVerify: true,
    now: () => {
      clock += 150;
      return clock;
    },
  });

  assert.deepEqual(allowlist, ["https://api.deepseek.com/v1/"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/models");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.skipTLSVerify, true);
  assert.deepEqual(calls[0]?.headers, { Authorization: "Bearer sk-test" });
  assert.equal(run.ok, true);
  if (!run.ok) throw new Error("expected probe success");
  assert.equal(run.classification.health, "ok");
  assert.equal(run.classification.latencyMs, 150);
  assert.equal(run.classification.modelCount, 1);
});

test("probeProviderConnection returns typed failures before fetch", async () => {
  assert.deepEqual(
    await probeProviderConnection({
      bridge: { aiFetch: async () => ({ ok: true, status: 200, data: "{}" }) },
      baseURL: "",
      apiKey: "sk",
      providerId: "openai",
      style: "openai",
    }),
    { ok: false, reason: "missing_base_url" },
  );
  assert.deepEqual(
    await probeProviderConnection({
      bridge: undefined,
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk",
      providerId: "openai",
      style: "openai",
    }),
    { ok: false, reason: "unavailable" },
  );
});

test("probeProviderConnection does not double /v1 for Anthropic AI SDK style bases", async () => {
  const calls: string[] = [];
  const run = await probeProviderConnection({
    bridge: {
      aiFetch: async (url) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          data: JSON.stringify({ data: [{ id: "claude-sonnet" }] }),
        };
      },
    },
    baseURL: "https://gateway.example/v1",
    apiKey: "sk-test",
    providerId: "custom",
    style: "anthropic",
  });
  assert.deepEqual(calls, ["https://gateway.example/v1/models"]);
  assert.equal(run.ok, true);
});

test("Volcengine Agent Plan OpenAI Detect distinguishes a missing catalog from a failed chat request", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const run = (baseURL: string, status: number, style: "openai" | "anthropic" = "openai") =>
    probeProviderConnection({
      bridge: {
        aiFetch: async (url, method) => {
          calls.push({ url, method });
          return { ok: false, status, data: "" };
        },
      },
      baseURL,
      apiKey: "fixture-key",
      providerId: "custom",
      style,
      now: () => 0,
    });

  const base = "https://ark.cn-beijing.volces.com/api/plan/v3";
  const missingCatalog = await run(base + "/", 404);
  assert.deepEqual(missingCatalog, {
    ok: true,
    classification: { health: "warn", statusCode: 404, latencyMs: 0, notice: "model-list-unavailable" },
  });
  assert.deepEqual(calls, [{ url: base + "/models", method: "GET" }]);
  for (const [url, status, style] of [
    [base, 401, "openai"],
    [base, 503, "openai"],
    [base, 404, "anthropic"],
    [base + "/typo", 404, "openai"],
    ["https://ark.cn-beijing.volces.com/api/v3", 404, "openai"],
    ["https://ark.cn-beijing.volces.com.evil.example/api/plan/v3", 404, "openai"],
    ["https://example.test/api/plan/v3", 404, "openai"],
  ] as const) {
    const result = await run(url, status, style);
    assert.ok(result.ok);
    assert.equal(result.classification.health, "error", `${url}: ${status} (${style})`);
    assert.equal(result.classification.notice, undefined);
  }
});
