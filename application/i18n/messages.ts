import en, { type Messages } from './locales/en';

// Keep keys stable; add new locales by adding a loader below and an entry in
// SUPPORTED_UI_LOCALES (infrastructure/config/i18n.ts).
export { type Messages };

/**
 * Lookup order for the "same base language" fallback in I18nProvider (for
 * example zh-TW falls back to zh-CN, the first `zh*` entry). Matches the key
 * order of the old static MESSAGES_BY_LOCALE map.
 */
export const LOCALE_MESSAGE_KEYS = ['en', 'ru', 'es', 'zh-CN', 'zh-TW'] as const;

/**
 * Only English is bundled with the startup chunk; other locales are loaded on
 * demand. All five dictionaries used to be parsed by every window at startup
 * (~1.3 MB of the entry chunk) even though one locale is in use.
 */
const LOCALE_LOADERS: Record<string, () => Promise<{ default: Messages }>> = {
  ru: () => import('./locales/ru'),
  es: () => import('./locales/es'),
  'zh-CN': () => import('./locales/zh-CN'),
  'zh-TW': () => import('./locales/zh-TW'),
};

const loadedMessages: Record<string, Messages> = { en };
const pendingLoads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let messagesVersion = 0;

export function getLoadedLocaleMessages(locale: string): Messages | undefined {
  return loadedMessages[locale];
}

export function getLocaleMessagesVersion(): number {
  return messagesVersion;
}

export function subscribeLocaleMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The same-base fallback locale that I18nProvider consults for `locale`. */
export function getBaseFallbackLocale(locale: string): string | undefined {
  const base = locale.split('-')[0];
  return LOCALE_MESSAGE_KEYS.find((key) => key === base || key.startsWith(`${base}-`));
}

function loadOne(locale: string): Promise<void> {
  if (loadedMessages[locale]) return Promise.resolve();
  const loader = LOCALE_LOADERS[locale];
  if (!loader) return Promise.resolve();
  let pending = pendingLoads.get(locale);
  if (!pending) {
    pending = loader()
      .then((module) => {
        loadedMessages[locale] = module.default;
        messagesVersion += 1;
        for (const listener of listeners) listener();
      })
      .finally(() => {
        pendingLoads.delete(locale);
      });
    pendingLoads.set(locale, pending);
  }
  return pending;
}

/** Load the dictionaries `locale` resolves through (itself and its base fallback). */
export function loadLocaleMessages(locale: string): Promise<void> {
  const needed = new Set([locale]);
  const fallback = getBaseFallbackLocale(locale);
  if (fallback) needed.add(fallback);
  return Promise.all([...needed].map(loadOne)).then(() => undefined);
}
