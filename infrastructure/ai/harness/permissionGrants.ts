import cattyToolSpecs from './generated/cattyToolSpecs.json';

export interface PermissionGrantRule {
  id: string;
  capabilityId: string;
  sessionPattern: string;
  commandPattern?: string;
  argsPattern?: Record<string, string>;
  createdAt: number;
  note?: string;
}

export interface PermissionGrantMatchContext {
  capabilityId: string;
  sessionId?: string;
  chatSessionId?: string;
  hostname?: string;
  args?: Record<string, unknown>;
}

type CattyToolSpecRef = {
  capabilityId: string;
  toolName: string;
  rpcMethod: string | null;
};

const TOOL_NAME_TO_CAPABILITY = new Map<string, string>();
const RPC_METHOD_TO_CAPABILITY = new Map<string, string>();

for (const spec of cattyToolSpecs as CattyToolSpecRef[]) {
  TOOL_NAME_TO_CAPABILITY.set(spec.toolName, spec.capabilityId);
  if (spec.rpcMethod) {
    RPC_METHOD_TO_CAPABILITY.set(spec.rpcMethod, spec.capabilityId);
  }
}

export function resolveCapabilityId(toolOrRpcName: string): string {
  return TOOL_NAME_TO_CAPABILITY.get(toolOrRpcName)
    ?? RPC_METHOD_TO_CAPABILITY.get(toolOrRpcName)
    ?? toolOrRpcName;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function patternMatches(pattern: string, value: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;

  if (pattern.startsWith('host:')) {
    return globOrRegexMatch(pattern.slice('host:'.length), value);
  }

  return globOrRegexMatch(pattern, value);
}

function globOrRegexMatch(pattern: string, value: string): boolean {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    try {
      return new RegExp(body, flags).test(value);
    } catch {
      return false;
    }
  }

  if (!pattern.includes('*')) {
    return value === pattern;
  }

  const parts = pattern.split('*').map(escapeRegex);
  const regex = new RegExp(`^${parts.join('.*')}$`);
  return regex.test(value);
}

function argsPatternMatches(
  argsPattern: Record<string, string> | undefined,
  args: Record<string, unknown> | undefined,
): boolean {
  if (!argsPattern) return true;
  if (!args) return false;

  for (const [key, pattern] of Object.entries(argsPattern)) {
    const argValue = args[key];
    if (typeof argValue === 'undefined') return false;
    if (!patternMatches(pattern, String(argValue))) return false;
  }
  return true;
}

function resolveSessionTarget(
  args: Record<string, unknown> | undefined,
  chatSessionId?: string,
  sessionId?: string,
): string {
  if (typeof args?.sessionId === 'string' && args.sessionId.length > 0) {
    return args.sessionId;
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return sessionId;
  }
  return chatSessionId ?? '';
}

function resolveHostname(
  args: Record<string, unknown> | undefined,
  hostname?: string,
): string {
  if (hostname) return hostname;
  if (typeof args?.hostname === 'string') return args.hostname;
  return '';
}

export function matchPermissionGrant(
  rules: readonly PermissionGrantRule[],
  ctx: PermissionGrantMatchContext,
): PermissionGrantRule | null {
  if (rules.length === 0) return null;

  const args = ctx.args ?? {};
  const sessionTarget = resolveSessionTarget(args, ctx.chatSessionId, ctx.sessionId);
  const hostname = resolveHostname(args, ctx.hostname);

  for (const rule of rules) {
    if (rule.capabilityId !== ctx.capabilityId) continue;

    const sessionPattern = rule.sessionPattern || '*';
    const sessionMatched = sessionPattern.startsWith('host:')
      ? patternMatches(sessionPattern, hostname)
      : patternMatches(sessionPattern, sessionTarget);
    if (!sessionMatched) continue;

    if (rule.commandPattern) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!patternMatches(rule.commandPattern, command)) continue;
    }

    if (!argsPatternMatches(rule.argsPattern, args)) continue;

    return rule;
  }

  return null;
}

export function sanitizePermissionGrants(raw: unknown): PermissionGrantRule[] {
  if (!Array.isArray(raw)) return [];

  const result: PermissionGrantRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const capabilityId = typeof record.capabilityId === 'string' ? record.capabilityId.trim() : '';
    const sessionPattern = typeof record.sessionPattern === 'string' ? record.sessionPattern.trim() : '';
    if (!capabilityId || !sessionPattern) continue;

    const rule: PermissionGrantRule = {
      id: typeof record.id === 'string' && record.id.trim()
        ? record.id.trim().slice(0, 64)
        : createPermissionGrantId(),
      capabilityId,
      sessionPattern,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : Date.now(),
    };

    if (typeof record.commandPattern === 'string' && record.commandPattern.trim()) {
      rule.commandPattern = record.commandPattern.trim();
    }
    if (record.argsPattern && typeof record.argsPattern === 'object' && !Array.isArray(record.argsPattern)) {
      const argsPattern: Record<string, string> = {};
      for (const [key, value] of Object.entries(record.argsPattern as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) {
          argsPattern[key] = value.trim();
        }
      }
      if (Object.keys(argsPattern).length > 0) {
        rule.argsPattern = argsPattern;
      }
    }
    if (typeof record.note === 'string' && record.note.trim()) {
      rule.note = record.note.trim().slice(0, 240);
    }

    result.push(rule);
  }

  return result;
}

export function createPermissionGrantId(): string {
  return `grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildGrantFromApproval(
  capabilityId: string,
  args: Record<string, unknown>,
  chatSessionId?: string,
): PermissionGrantRule {
  const sessionPattern = typeof args.sessionId === 'string' && args.sessionId
    ? args.sessionId
    : (chatSessionId ?? '*');
  const commandPattern = typeof args.command === 'string' && args.command.trim()
    ? args.command.trim()
    : undefined;

  return {
    id: createPermissionGrantId(),
    capabilityId,
    sessionPattern,
    commandPattern,
    createdAt: Date.now(),
  };
}

let activeRules: PermissionGrantRule[] = [];

export function setActivePermissionGrants(rules: PermissionGrantRule[]): void {
  activeRules = [...rules];
}

export function getActivePermissionGrants(): readonly PermissionGrantRule[] {
  return activeRules;
}

export class PermissionGrantStore {
  private rules: PermissionGrantRule[];

  constructor(rules: PermissionGrantRule[] = []) {
    this.rules = [...rules];
  }

  getRules(): readonly PermissionGrantRule[] {
    return this.rules;
  }

  setRules(rules: PermissionGrantRule[]): void {
    this.rules = [...rules];
  }

  addRule(rule: PermissionGrantRule): void {
    this.rules = [...this.rules, rule];
  }

  updateRule(id: string, updates: Partial<Omit<PermissionGrantRule, 'id' | 'createdAt'>>): void {
    this.rules = this.rules.map((rule) => (
      rule.id === id ? { ...rule, ...updates } : rule
    ));
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((rule) => rule.id !== id);
  }

  match(ctx: PermissionGrantMatchContext): PermissionGrantRule | null {
    return matchPermissionGrant(this.rules, ctx);
  }
}
