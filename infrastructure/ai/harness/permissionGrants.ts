import cattyToolSpecs from './generated/cattyToolSpecs.json';
import { buildAlwaysAllowCommandPatterns } from '../shared/shellCommandGrant';

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
  policy?: {
    write?: boolean;
    bypassesApproval?: boolean;
  };
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

  if (!pattern.includes('*') && !pattern.includes('?')) {
    return value === pattern;
  }

  // OpenCode Wildcard.match semantics (trailing " *" allows optional args).
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${escaped}$`, 's').test(value);
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

export function matchPermissionGrant(
  rules: readonly PermissionGrantRule[],
  ctx: PermissionGrantMatchContext,
): PermissionGrantRule | null {
  if (rules.length === 0) return null;

  const args = ctx.args ?? {};

  for (const rule of rules) {
    if (rule.capabilityId !== ctx.capabilityId) continue;

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
    if (!capabilityId) continue;

    const rule: PermissionGrantRule = {
      id: typeof record.id === 'string' && record.id.trim()
        ? record.id.trim().slice(0, 64)
        : createPermissionGrantId(),
      capabilityId,
      sessionPattern: typeof record.sessionPattern === 'string' && record.sessionPattern.trim()
        ? record.sessionPattern.trim()
        : '*',
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

const COMMAND_GRANT_CAPABILITIES = new Set([
  'terminal.execute',
  'terminal.start',
]);

const GRANTABLE_CAPABILITY_IDS: readonly string[] = Object.freeze(
  [...new Set(
    (cattyToolSpecs as CattyToolSpecRef[])
      .filter((spec) => spec.policy?.write && !spec.policy?.bypassesApproval)
      .map((spec) => spec.capabilityId),
  )].sort(),
);

export function listGrantableCapabilityIds(): readonly string[] {
  return GRANTABLE_CAPABILITY_IDS;
}

export function capabilitySupportsCommandPatternGrant(capabilityId: string): boolean {
  return COMMAND_GRANT_CAPABILITIES.has(capabilityId);
}

function resolveCommandGrantPatterns(
  capabilityId: string,
  args: Record<string, unknown>,
): string[] | undefined {
  if (!COMMAND_GRANT_CAPABILITIES.has(capabilityId)) return undefined;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return undefined;
  return buildAlwaysAllowCommandPatterns(command);
}

export function buildGrantsFromApproval(
  capabilityId: string,
  args: Record<string, unknown>,
  _chatSessionId?: string,
): PermissionGrantRule[] {
  // OpenCode-style always-allow: global scope (not bound to a terminal session UUID).
  const sessionPattern = '*';
  const commandPatterns = resolveCommandGrantPatterns(capabilityId, args);
  const createdAt = Date.now();

  if (!commandPatterns || commandPatterns.length === 0) {
    return [{
      id: createPermissionGrantId(),
      capabilityId,
      sessionPattern,
      createdAt,
    }];
  }

  return commandPatterns.map((commandPattern) => ({
    id: createPermissionGrantId(),
    capabilityId,
    sessionPattern,
    commandPattern,
    createdAt,
  }));
}

export function buildGrantFromApproval(
  capabilityId: string,
  args: Record<string, unknown>,
  chatSessionId?: string,
): PermissionGrantRule {
  return buildGrantsFromApproval(capabilityId, args, chatSessionId)[0];
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
