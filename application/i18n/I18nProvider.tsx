import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_UI_LOCALE, resolveSupportedLocale } from '../../infrastructure/config/i18n';
import {
  getBaseFallbackLocale,
  getLoadedLocaleMessages,
  getLocaleMessagesVersion,
  loadLocaleMessages,
  subscribeLocaleMessages,
  type Messages,
} from './messages';

type InterpolationValues = Record<string, string | number | boolean | null | undefined>;

export type I18nContextValue = {
  locale: string;
  resolvedLocale: string;
  t: (key: string, values?: InterpolationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

const interpolate = (template: string, values?: InterpolationValues): string => {
  if (!values) return template;
  const replaceDoubleBraceToken = (match: string, key: string) => {
    const v = values[key];
    if (v === null || v === undefined) return match;
    return String(v);
  };
  const replaceSingleBraceToken = (_match: string, key: string) => {
    const v = values[key];
    if (v === null || v === undefined) return '';
    return String(v);
  };
  return template
    .replace(/\{\{(\w+)\}\}/g, replaceDoubleBraceToken)
    .replace(/\{(\w+)\}/g, replaceSingleBraceToken);
};

type LocaleDictionaries = {
  direct?: Messages;
  base?: Messages;
  fallback?: Messages;
};

/**
 * Dictionaries consulted for `resolvedLocale`: exact locale, same-base sibling
 * (zh-TW -> zh-CN), then English. `_loadedVersion` is only a cache key so a
 * dictionary that finishes loading yields a fresh snapshot.
 */
const snapshotLocaleDictionaries = (resolvedLocale: string, _loadedVersion: number): LocaleDictionaries => {
  const baseKey = getBaseFallbackLocale(resolvedLocale);
  return {
    direct: getLoadedLocaleMessages(resolvedLocale),
    base: baseKey ? getLoadedLocaleMessages(baseKey) : undefined,
    fallback: getLoadedLocaleMessages(DEFAULT_UI_LOCALE),
  };
};

const resolveMessage = (dictionaries: LocaleDictionaries, key: string): string | undefined =>
  dictionaries.direct?.[key] || dictionaries.base?.[key] || dictionaries.fallback?.[key];

export const I18nProvider: React.FC<{ locale: string; children: React.ReactNode }> = ({
  locale,
  children,
}) => {
  const resolvedLocale = resolveSupportedLocale(locale || DEFAULT_UI_LOCALE);
  // Non-English dictionaries load on demand (index.tsx preloads the saved one
  // before the first render); re-render consumers once a switch finishes.
  const messagesVersion = useSyncExternalStore(
    subscribeLocaleMessages,
    getLocaleMessagesVersion,
    getLocaleMessagesVersion,
  );
  useEffect(() => {
    void loadLocaleMessages(resolvedLocale).catch(() => {});
  }, [resolvedLocale]);
  const dictionaries = useMemo(
    () => snapshotLocaleDictionaries(resolvedLocale, messagesVersion),
    [resolvedLocale, messagesVersion],
  );

  const value = useMemo<I18nContextValue>(() => {
    return {
      locale,
      resolvedLocale,
      t: (key, values) => {
        const msg = resolveMessage(dictionaries, key) ?? key;
        return interpolate(msg, values);
      },
    };
  }, [dictionaries, locale, resolvedLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nContextValue => {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    return {
      locale: DEFAULT_UI_LOCALE,
      resolvedLocale: DEFAULT_UI_LOCALE,
      t: (key) => key,
    };
  }
  return ctx;
};

