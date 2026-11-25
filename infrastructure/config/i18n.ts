export type LocaleOption = {
  id: string;
  label: string;
};

export const DEFAULT_UI_LOCALE = 'en';

// Add new languages by appending to this list and providing message dictionaries.
export const SUPPORTED_UI_LOCALES: LocaleOption[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'ru', label: 'Русский' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
];

const TRADITIONAL_CHINESE_REGIONS = new Set(['tw', 'hk', 'mo']);

export const matchSupportedLocale = (locale: string): string | null => {
  if (typeof locale !== 'string') return null;
  const normalized = locale.trim().replace(/_/g, '-');
  if (!normalized) return null;

  const rawParts = normalized.split('-').filter(Boolean);
  if (rawParts.length === 0) return null;

  const lowerParts = rawParts.map((part) => part.toLowerCase());
  const primary = lowerParts[0];

  if (primary === 'zh') {
    // Stop before BCP-47 extension/private-use singletons (e.g. -u-, -t-, -x-).
    const coreSubtags: string[] = [];
    for (let i = 1; i < lowerParts.length; i += 1) {
      if (lowerParts[i].length === 1) break;
      coreSubtags.push(lowerParts[i]);
    }
    if (coreSubtags.includes('hant')) return 'zh-TW';
    if (coreSubtags.includes('hans')) return 'zh-CN';
    if (coreSubtags.some((part) => TRADITIONAL_CHINESE_REGIONS.has(part))) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }

  const normalizedLower = lowerParts.join('-');
  const exact = SUPPORTED_UI_LOCALES.find((l) => l.id.toLowerCase() === normalizedLower)?.id;
  if (exact) return exact;

  const baseExact = SUPPORTED_UI_LOCALES.find((l) => l.id.toLowerCase() === primary)?.id;
  if (baseExact) return baseExact;

  const basePrefix = SUPPORTED_UI_LOCALES.find((l) =>
    l.id.toLowerCase().startsWith(`${primary}-`),
  )?.id;
  if (basePrefix) return basePrefix;

  return null;
};

export const resolveSupportedLocale = (locale: string): string => {
  return matchSupportedLocale(locale) ?? DEFAULT_UI_LOCALE;
};

export function getSystemLocales(
  nav?: Partial<Pick<Navigator, 'languages' | 'language'>> | null,
): readonly string[] {
  const source = arguments.length === 0
    ? (typeof navigator !== 'undefined' ? navigator : undefined)
    : nav;
  if (!source) return [];
  const locales: string[] = [];
  if (Array.isArray(source.languages)) {
    for (const locale of source.languages) {
      if (typeof locale === 'string' && locale.trim()) {
        locales.push(locale);
      }
    }
  }
  if (typeof source.language === 'string' && source.language.trim()) {
    if (!locales.includes(source.language)) {
      locales.push(source.language);
    }
  }
  return locales;
}

export const resolveDefaultUiLocale = (
  storedLocale: string | null | undefined,
  systemLocales?: readonly string[] | null,
): string => {
  const trimmedStored = typeof storedLocale === 'string' ? storedLocale.trim() : '';
  if (trimmedStored) {
    return resolveSupportedLocale(trimmedStored);
  }

  const candidates = systemLocales === undefined ? getSystemLocales() : (systemLocales ?? []);
  for (const candidate of candidates) {
    const matched = matchSupportedLocale(candidate);
    if (matched) return matched;
  }

  return DEFAULT_UI_LOCALE;
};

