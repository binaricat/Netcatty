import type { ProviderStyle } from "./types";
import {
  buildModelDiscoveryHeaders,
  STYLE_DEFAULT_MODELS_ENDPOINT,
} from "./modelDiscoveryHeaders";

export type ProviderProbeHealth = "ok" | "warn" | "error";

export type ProviderProbeInputIssue = "missing_base_url" | "missing_api_key";

export type ProviderProbeUnavailableReason = "unavailable";

export type ProviderProbeClassification = {
  health: ProviderProbeHealth;
  latencyMs: number;
  statusCode: number;
  modelCount?: number;
  error?: string;
};

/** Minimal bridge surface needed to probe a provider endpoint. */
export type ProviderProbeFetchBridge = {
  aiFetch?: (
    url: string,
    method?: string,
    headers?: Record<string, string>,
    body?: string,
    providerId?: string,
    skipHostCheck?: boolean,
    followRedirects?: boolean,
    skipTLSVerify?: boolean,
  ) => Promise<{ ok: boolean; status?: number; data: string; error?: string }>;
  aiAllowlistAddHost?: (baseURL: string) => Promise<{ ok: boolean }>;
};

export type ProviderProbeRunResult =
  | { ok: false; reason: ProviderProbeInputIssue | ProviderProbeUnavailableReason }
  | { ok: true; classification: ProviderProbeClassification };

/**
 * Probe-specific discovery path. Same conventions as model listing, but Google
 * Generative Language exposes `GET /models`, so the settings "Test" button can
 * validate key + connectivity without opening chat.
 */
export function resolveProviderProbeEndpoint(
  style: ProviderStyle,
  presetEndpoint?: string,
): string | undefined {
  if (style === "google") return "/models";
  return STYLE_DEFAULT_MODELS_ENDPOINT[style] ?? presetEndpoint;
}

export function buildProviderProbeUrl(baseURL: string, endpoint: string): string {
  return `${baseURL.replace(/\/+$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

export function validateProviderProbeInputs(input: {
  baseURL: string;
  apiKey: string;
  providerId: string;
}): { ok: true } | { ok: false; reason: ProviderProbeInputIssue } {
  if (!input.baseURL.trim()) return { ok: false, reason: "missing_base_url" };
  const needsApiKey = input.providerId !== "ollama";
  if (needsApiKey && !input.apiKey.trim()) return { ok: false, reason: "missing_api_key" };
  return { ok: true };
}

function countModelsInPayload(data: string | undefined): number | undefined {
  if (data == null || data.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const rawModels = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : null;
    if (!rawModels) return undefined;
    return rawModels.filter((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const model = raw as Record<string, unknown>;
      // OpenAI-compat uses `id`; Google ListModels uses `name` (e.g. models/gemini-…).
      return (typeof model.id === "string" && model.id.length > 0)
        || (typeof model.name === "string" && model.name.length > 0);
    }).length;
  } catch {
    return undefined;
  }
}

/**
 * Map a lightweight `/models` (or equivalent) probe response to green / yellow / red.
 * Yellow covers slow-but-successful replies and empty model catalogs.
 */
export function classifyProviderProbeResponse(input: {
  ok: boolean;
  status: number;
  latencyMs: number;
  data?: string;
  error?: string;
  slowThresholdMs?: number;
}): ProviderProbeClassification {
  const slowThresholdMs = input.slowThresholdMs ?? 3000;
  const base = {
    latencyMs: input.latencyMs,
    statusCode: input.status,
    ...(input.error ? { error: input.error } : {}),
  };

  if (!input.ok || input.status < 200 || input.status >= 300) {
    return {
      ...base,
      health: "error",
      error: input.error || (input.status ? `HTTP ${input.status}` : "Request failed"),
    };
  }

  const modelCount = countModelsInPayload(input.data);
  if (modelCount === undefined) {
    return {
      ...base,
      health: "warn",
      error: "Unexpected response body",
    };
  }
  if (modelCount === 0 || input.latencyMs >= slowThresholdMs) {
    return {
      ...base,
      health: "warn",
      modelCount,
    };
  }
  return {
    ...base,
    health: "ok",
    modelCount,
  };
}

/**
 * Run a lightweight connectivity probe against the provider's models listing
 * endpoint. Owns allowlist mutation, auth headers, URL construction, and the
 * bridge fetch so UI only maps the typed result to presentation.
 */
export async function probeProviderConnection(input: {
  bridge: ProviderProbeFetchBridge | undefined;
  baseURL: string;
  apiKey: string;
  providerId: string;
  style: ProviderStyle;
  presetModelsEndpoint?: string;
  skipTLSVerify?: boolean;
  slowThresholdMs?: number;
  now?: () => number;
}): Promise<ProviderProbeRunResult> {
  const baseURL = input.baseURL.trim();
  const inputCheck = validateProviderProbeInputs({
    baseURL,
    apiKey: input.apiKey,
    providerId: input.providerId,
  });
  if (!inputCheck.ok) return inputCheck;

  const endpoint = resolveProviderProbeEndpoint(input.style, input.presetModelsEndpoint);
  if (!endpoint) return { ok: false, reason: "unavailable" };

  const bridge = input.bridge;
  if (!bridge?.aiFetch) return { ok: false, reason: "unavailable" };

  const now = input.now ?? Date.now;
  const startedAt = now();
  if (bridge.aiAllowlistAddHost) {
    await bridge.aiAllowlistAddHost(baseURL);
  }
  const url = buildProviderProbeUrl(baseURL, endpoint);
  const headers = buildModelDiscoveryHeaders(input.style, input.apiKey);
  const result = await bridge.aiFetch(
    url,
    "GET",
    headers,
    undefined,
    undefined,
    undefined,
    undefined,
    input.skipTLSVerify,
  );
  return {
    ok: true,
    classification: classifyProviderProbeResponse({
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 0),
      latencyMs: Math.max(0, now() - startedAt),
      data: result.data,
      error: result.error,
      slowThresholdMs: input.slowThresholdMs,
    }),
  };
}
