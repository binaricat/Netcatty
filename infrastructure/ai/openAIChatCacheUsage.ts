/** Adapt DeepSeek's documented usage fields before the OpenAI SDK validates them. */
export function normalizeOpenAIChatCacheUsage(data: string): string {
  if (!data.includes('prompt_cache_hit_tokens')) return data;
  try {
    const body = JSON.parse(data);
    const usage = body?.usage;
    const hit = usage?.prompt_cache_hit_tokens;
    if (!Number.isSafeInteger(hit) || hit < 0) return data;
    if (Number.isFinite(usage.prompt_tokens) && hit > usage.prompt_tokens) return data;
    // Preserve a provider's standard field, including an explicit zero.
    if (usage.prompt_tokens_details?.cached_tokens != null) return data;
    usage.prompt_tokens_details = { ...usage.prompt_tokens_details, cached_tokens: hit };
    return JSON.stringify(body);
  } catch {
    return data;
  }
}
