export type LocaleOption = {
  id: string;
  label: string;
};

export const DEFAULT_UI_LOCALE = 'en';

// Add new languages by appending to this list and providing message dictionaries.
export const SUPPORTED_UI_LOCALES: LocaleOption[] = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
];

const isSupportedLocale = (locale: string): boolean => {
  return SUPPORTED_UI_LOCALES.some((l) => l.id === locale);
};

export const resolveSupportedLocale = (locale: string): string => {
  if (isSupportedLocale(locale)) return locale;
  const base = locale.split('-')[0] || locale;
  const baseExact = SUPPORTED_UI_LOCALES.find((l) => l.id === base)?.id;
  if (baseExact) return baseExact;
  const basePrefix = SUPPORTED_UI_LOCALES.find((l) => l.id.startsWith(`${base}-`))?.id;
  if (basePrefix) return basePrefix;
  return DEFAULT_UI_LOCALE;
};

