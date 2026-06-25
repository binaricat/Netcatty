export interface AIQuickMessage {
  id: string;
  /** Display label shown in pickers and settings. */
  name: string;
  /** Slash-command token, e.g. `status` for `/status`. */
  slug: string;
  /** Prompt text inserted into the composer when selected. */
  content: string;
  /** Optional short hint shown in the slash picker. */
  description?: string;
}

export interface UserSkillSlashOption {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export type SlashCommandItem =
  | { kind: 'quickMessage'; message: AIQuickMessage }
  | { kind: 'skill'; skill: UserSkillSlashOption };

export const QUICK_MESSAGE_LIMITS = {
  name: 120,
  slug: 48,
  description: 240,
  content: 10000,
  maxItems: 200,
} as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeQuickMessageSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, QUICK_MESSAGE_LIMITS.slug);
}

export function isValidQuickMessageSlug(slug: string): boolean {
  return slug.length > 0 && SLUG_PATTERN.test(slug);
}

export function slugFromQuickMessageName(name: string): string {
  return normalizeQuickMessageSlug(name);
}

function clampString(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLen);
}

/** Validate and dedupe quick messages from localStorage or cloud sync. */
export function sanitizeQuickMessages(raw: unknown): AIQuickMessage[] {
  if (!Array.isArray(raw)) return [];

  const seenSlugs = new Set<string>();
  const result: AIQuickMessage[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const idRaw = typeof record.id === 'string' ? record.id.trim() : '';
    const id = idRaw.length > 0 ? idRaw.slice(0, 64) : createQuickMessageId();
    const name = clampString(record.name, QUICK_MESSAGE_LIMITS.name).trim();
    const slug = normalizeQuickMessageSlug(clampString(record.slug, QUICK_MESSAGE_LIMITS.slug));
    const content = clampString(record.content, QUICK_MESSAGE_LIMITS.content).trim();
    const description = clampString(record.description, QUICK_MESSAGE_LIMITS.description).trim();

    if (!name || !isValidQuickMessageSlug(slug) || !content) continue;
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    result.push({
      id,
      name,
      slug,
      content,
      description: description || undefined,
    });

    if (result.length >= QUICK_MESSAGE_LIMITS.maxItems) break;
  }

  return result;
}

export function filterQuickMessages(
  messages: AIQuickMessage[],
  query: string,
): AIQuickMessage[] {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return messages;
  return messages.filter((message) => {
    const slug = message.slug.toLowerCase();
    const name = message.name.toLowerCase();
    return slug.startsWith(lowerQuery) || name.includes(lowerQuery);
  });
}

export function filterUserSkillsForSlash(
  skills: UserSkillSlashOption[],
  query: string,
): UserSkillSlashOption[] {
  return skills.filter((skill) => {
    if (typeof skill.slug !== 'string' || skill.slug.length === 0) return false;
    if (!slashQueryMatches(query, skill.slug, skill.name)) return false;
    return true;
  });
}

function slashQueryMatches(query: string, slug: string, name: string): boolean {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return true;
  return slug.toLowerCase().startsWith(lowerQuery) || name.toLowerCase().includes(lowerQuery);
}

export function buildSlashCommandItems(
  quickMessages: AIQuickMessage[],
  userSkills: UserSkillSlashOption[],
  query: string,
): SlashCommandItem[] {
  const reservedSlugs = new Set(quickMessages.map((message) => message.slug));
  const filteredMessages = filterQuickMessages(quickMessages, query);
  return [
    ...filteredMessages.map((message) => ({
      kind: 'quickMessage' as const,
      message,
    })),
    ...filterUserSkillsForSlash(userSkills, query)
      .filter((skill) => !reservedSlugs.has(skill.slug))
      .map((skill) => ({
        kind: 'skill' as const,
        skill,
      })),
  ];
}

export function getSlashCommandItemKey(item: SlashCommandItem): string {
  return item.kind === 'quickMessage' ? `qm:${item.message.id}` : `sk:${item.skill.id}`;
}

export function getSlashCommandItemId(item: SlashCommandItem): string {
  return item.kind === 'quickMessage' ? item.message.id : item.skill.id;
}

export function createQuickMessageId(): string {
  return `qm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Built-in slash commands — not stored in user quick messages. */
export const SYSTEM_BUILTIN_SLASH_COMMANDS = {
  stop: {
    slug: 'stop',
    descriptionKey: 'ai.chat.slashStopDesc',
  },
} as const;

export function isSystemStopSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  return /^\/stop(?:\s|$)/i.test(trimmed) || trimmed.toLowerCase() === '/stop';
}
