export const DEFAULT_MAX_TOOL_CALLS = 60;
export const DEFAULT_MAX_TOKENS = 0;
export const DEFAULT_MAX_COST_USD = 0;
export const DEFAULT_COST_PER_MILLION_TOKENS_USD = 0;

export interface AgentBudgetLimits {
  maxSteps: number;
  maxToolCalls: number;
  /** 0 disables the token budget. */
  maxTokens: number;
  /** 0 disables the cost budget. */
  maxCostUsd: number;
  /** Used when the provider does not emit explicit cost metadata. */
  costPerMillionTokensUsd: number;
}

export interface AgentBudgetUsage {
  steps: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
}

export interface AgentBudgetStopReason {
  kind: 'steps' | 'tool-calls' | 'tokens' | 'cost';
  message: string;
  usage: AgentBudgetUsage;
  limit: number;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

export function normalizeAgentBudgetLimits(input: Partial<AgentBudgetLimits>): AgentBudgetLimits {
  return {
    maxSteps: clampNumber(input.maxSteps, 20, 1, 100),
    maxToolCalls: clampNumber(input.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, 1, 500),
    maxTokens: clampNumber(input.maxTokens, DEFAULT_MAX_TOKENS, 0, 10_000_000),
    maxCostUsd: clampNumber(input.maxCostUsd, DEFAULT_MAX_COST_USD, 0, 10_000),
    costPerMillionTokensUsd: clampNumber(
      input.costPerMillionTokensUsd,
      DEFAULT_COST_PER_MILLION_TOKENS_USD,
      0,
      10_000,
    ),
  };
}

function readNumericField(value: unknown, fieldNames: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const fieldName of fieldNames) {
    const numeric = Number(record[fieldName]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

export function extractTokenCountFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const total = readNumericField(usage, ['totalTokens', 'totalTokenCount', 'tokens']);
  if (total != null) return Math.max(0, Math.round(total));
  const input = readNumericField(usage, ['inputTokens', 'promptTokens', 'promptTokenCount']) ?? 0;
  const output = readNumericField(usage, ['outputTokens', 'completionTokens', 'completionTokenCount']) ?? 0;
  return Math.max(0, Math.round(input + output));
}

export function extractCostUsdFromUsage(
  usage: unknown,
  tokenCount: number,
  costPerMillionTokensUsd: number,
): number {
  const explicitCost = readNumericField(usage, ['costUsd', 'totalCostUsd', 'cost', 'totalCost']);
  if (explicitCost != null) return Math.max(0, explicitCost);
  if (costPerMillionTokensUsd <= 0 || tokenCount <= 0) return 0;
  return (tokenCount / 1_000_000) * costPerMillionTokensUsd;
}

export class AgentBudgetTracker {
  private readonly limits: AgentBudgetLimits;
  private usage: AgentBudgetUsage = { steps: 0, toolCalls: 0, tokens: 0, costUsd: 0 };
  private stopReason: AgentBudgetStopReason | null = null;

  constructor(limits: AgentBudgetLimits) {
    this.limits = limits;
  }

  getUsage(): AgentBudgetUsage {
    return { ...this.usage };
  }

  getStopReason(): AgentBudgetStopReason | null {
    return this.stopReason ? { ...this.stopReason, usage: { ...this.stopReason.usage } } : null;
  }

  recordToolCall(): AgentBudgetStopReason | null {
    this.usage.toolCalls += 1;
    return this.evaluate();
  }

  recordStepUsage(usage: unknown): AgentBudgetStopReason | null {
    this.usage.steps += 1;
    const tokenCount = extractTokenCountFromUsage(usage);
    this.usage.tokens += tokenCount;
    this.usage.costUsd += extractCostUsdFromUsage(
      usage,
      tokenCount,
      this.limits.costPerMillionTokensUsd,
    );
    return this.evaluate();
  }

  syncFromSteps(steps: unknown[]): AgentBudgetStopReason | null {
    if (!Array.isArray(steps)) return this.evaluate();
    let tokens = 0;
    let costUsd = 0;
    for (const step of steps) {
      const usage = step && typeof step === 'object'
        ? (step as Record<string, unknown>).usage
        : undefined;
      const tokenCount = extractTokenCountFromUsage(usage);
      tokens += tokenCount;
      costUsd += extractCostUsdFromUsage(usage, tokenCount, this.limits.costPerMillionTokensUsd);
    }
    this.usage = {
      ...this.usage,
      steps: Math.max(this.usage.steps, steps.length),
      tokens: Math.max(this.usage.tokens, tokens),
      costUsd: Math.max(this.usage.costUsd, costUsd),
    };
    return this.evaluate();
  }

  private evaluate(): AgentBudgetStopReason | null {
    if (this.stopReason) return this.stopReason;
    if (this.usage.steps >= this.limits.maxSteps) {
      return this.setStopReason('steps', this.limits.maxSteps);
    }
    if (this.usage.toolCalls >= this.limits.maxToolCalls) {
      return this.setStopReason('tool-calls', this.limits.maxToolCalls);
    }
    if (this.limits.maxTokens > 0 && this.usage.tokens >= this.limits.maxTokens) {
      return this.setStopReason('tokens', this.limits.maxTokens);
    }
    if (this.limits.maxCostUsd > 0 && this.usage.costUsd >= this.limits.maxCostUsd) {
      return this.setStopReason('cost', this.limits.maxCostUsd);
    }
    return null;
  }

  private setStopReason(kind: AgentBudgetStopReason['kind'], limit: number): AgentBudgetStopReason {
    const label = kind === 'tool-calls' ? 'tool calls' : kind;
    this.stopReason = {
      kind,
      limit,
      usage: this.getUsage(),
      message: `Agent budget exceeded: ${label} limit ${limit} reached.`,
    };
    return this.stopReason;
  }
}

export function createBudgetStopCondition(tracker: AgentBudgetTracker) {
  return ({ steps }: { steps?: unknown[] } = {}): boolean => {
    tracker.syncFromSteps(Array.isArray(steps) ? steps : []);
    return Boolean(tracker.getStopReason());
  };
}
