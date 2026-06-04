import { sanitizeContextWindow } from "../../../../infrastructure/ai/contextCompaction";
import type { FetchedModel } from "./types";

export function parseFetchedModels(parsed: unknown): FetchedModel[] {
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  return rawModels
    .map((raw): FetchedModel | null => {
      if (!raw || typeof raw !== "object") return null;
      const model = raw as Record<string, unknown>;
      if (typeof model.id !== "string" || !model.id) return null;
      return {
        id: model.id,
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(resolveModelContextWindow(model) != null ? { contextWindow: resolveModelContextWindow(model) } : {}),
      };
    })
    .filter((model): model is FetchedModel => model != null);
}

export function mergeModelContextWindow(
  current: Record<string, number> | undefined,
  modelId: string,
  contextWindow: number | undefined,
): Record<string, number> | undefined {
  const sanitized = sanitizeContextWindow(contextWindow);
  if (!modelId || sanitized == null) return current;
  return { ...(current ?? {}), [modelId]: sanitized };
}

function resolveModelContextWindow(model: Record<string, unknown>): number | undefined {
  return sanitizeContextWindow(
    model.context_length
      ?? model.context_window
      ?? model.contextWindow
      ?? model.context
      ?? model.max_context_tokens,
  );
}
