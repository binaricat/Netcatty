import React, { createContext, useContext, useMemo } from 'react';
import { DEFAULT_UI_LOCALE, resolveSupportedLocale } from '../../infrastructure/config/i18n';
import { MESSAGES_BY_LOCALE } from './messages';

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

const resolveMessage = (resolvedLocale: string, key: string): string | undefined => {
  const direct = MESSAGES_BY_LOCALE[resolvedLocale]?.[key];
  if (direct) return direct;
  const base = resolvedLocale.split('-')[0];
  const baseKey = Object.keys(MESSAGES_BY_LOCALE).find((k) => k === base || k.startsWith(`${base}-`));
  const baseHit = baseKey ? MESSAGES_BY_LOCALE[baseKey]?.[key] : undefined;
  if (baseHit) return baseHit;
  return MESSAGES_BY_LOCALE[DEFAULT_UI_LOCALE]?.[key];
};

export const I18nProvider: React.FC<{ locale: string; children: React.ReactNode }> = ({
  locale,
  children,
}) => {
  const resolvedLocale = resolveSupportedLocale(locale || DEFAULT_UI_LOCALE);

  const value = useMemo<I18nContextValue>(() => {
    return {
      locale,
      resolvedLocale,
      t: (key, values) => {
        const msg = resolveMessage(resolvedLocale, key) ?? key;
        return interpolate(msg, values);
      },
    };
  }, [locale, resolvedLocale]);

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

