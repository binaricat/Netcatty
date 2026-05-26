import assert from "node:assert/strict";
import test from "node:test";

import { buildModelDiscoveryHeaders, resolveModelsDiscoveryEndpoint } from "./modelDiscoveryHeaders";

test("buildModelDiscoveryHeaders uses x-api-key+anthropic-version for the anthropic family", () => {
  assert.deepEqual(buildModelDiscoveryHeaders("anthropic", "sk-test"), {
    "x-api-key": "sk-test",
    "anthropic-version": "2023-06-01",
  });
});

test("buildModelDiscoveryHeaders uses Bearer auth for the openai-compatible family", () => {
  assert.deepEqual(buildModelDiscoveryHeaders("openai", "sk-test"), {
    Authorization: "Bearer sk-test",
  });
});

test("buildModelDiscoveryHeaders uses x-goog-api-key for the google family", () => {
  // Google Generative AI rejects Bearer auth — discovery has to match
  // the createGoogleGenerativeAI runtime client, which uses x-goog-api-key.
  assert.deepEqual(buildModelDiscoveryHeaders("google", "AIza-test"), {
    "x-goog-api-key": "AIza-test",
  });
});

test("buildModelDiscoveryHeaders returns no headers when the api key is missing", () => {
  assert.deepEqual(buildModelDiscoveryHeaders("anthropic", undefined), {});
  assert.deepEqual(buildModelDiscoveryHeaders("openai", ""), {});
});

test("buildModelDiscoveryHeaders honors the style override on an anthropic providerId pointing at an OpenAI-compatible backend", () => {
  // Regression: PR #1105 lets users pick `style` independently from
  // `providerId`. Without this fix the discovery call still sent
  // `x-api-key` because the old code switched on `providerId === "anthropic"`.
  assert.deepEqual(buildModelDiscoveryHeaders("openai", "sk-test"), {
    Authorization: "Bearer sk-test",
  });
});

test("resolveModelsDiscoveryEndpoint follows the resolved style by default", () => {
  assert.equal(resolveModelsDiscoveryEndpoint("openai"), "/models");
  assert.equal(resolveModelsDiscoveryEndpoint("anthropic"), "/v1/models");
  assert.equal(resolveModelsDiscoveryEndpoint("google"), undefined);
});

test("resolveModelsDiscoveryEndpoint overrides the preset path when style flips", () => {
  // Anthropic providerId preset would otherwise pin /v1/models, but the user
  // switched style to openai — pick /models instead so the path matches the
  // protocol family the headers already speak.
  assert.equal(resolveModelsDiscoveryEndpoint("openai", "/v1/models"), "/models");
  assert.equal(resolveModelsDiscoveryEndpoint("anthropic", "/models"), "/v1/models");
});

test("resolveModelsDiscoveryEndpoint falls back to the preset path only when the style has no convention", () => {
  // google has no STYLE_DEFAULT — preserve whatever the caller passed.
  assert.equal(resolveModelsDiscoveryEndpoint("google", "/custom/list"), "/custom/list");
  assert.equal(resolveModelsDiscoveryEndpoint("google", undefined), undefined);
});
