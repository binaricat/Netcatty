import { Host } from './models';

const hasLegacyStringValue = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const hasLegacyNumberValue = (value: number | undefined): boolean =>
  typeof value === 'number' && !Number.isNaN(value);

const hasEffectiveOverride = (
  explicitOverride: boolean | undefined,
  legacyValuePresent: boolean,
): boolean => explicitOverride === true || (explicitOverride === undefined && legacyValuePresent);

export const hasHostThemeOverride = (host?: Pick<Host, 'themeOverride' | 'theme'> | null): boolean =>
  hasEffectiveOverride(host?.themeOverride, hasLegacyStringValue(host?.theme));

export const hasHostFontFamilyOverride = (host?: Pick<Host, 'fontFamilyOverride' | 'fontFamily'> | null): boolean =>
  hasEffectiveOverride(host?.fontFamilyOverride, hasLegacyStringValue(host?.fontFamily));

export const hasHostFontSizeOverride = (host?: Pick<Host, 'fontSizeOverride' | 'fontSize'> | null): boolean =>
  hasEffectiveOverride(host?.fontSizeOverride, hasLegacyNumberValue(host?.fontSize));

export const clearHostThemeOverride = (host: Host): Host => ({
  ...host,
  theme: undefined,
  themeOverride: false,
});

export const clearHostFontFamilyOverride = (host: Host): Host => ({
  ...host,
  fontFamily: undefined,
  fontFamilyOverride: false,
});

export const clearHostFontSizeOverride = (host: Host): Host => ({
  ...host,
  fontSize: undefined,
  fontSizeOverride: false,
});

export const resolveHostTerminalThemeId = (host: Host | null | undefined, defaultThemeId: string): string =>
  hasHostThemeOverride(host) && host?.theme ? host.theme : defaultThemeId;

export const resolveHostTerminalFontFamilyId = (host: Host | null | undefined, defaultFontFamilyId: string): string =>
  hasHostFontFamilyOverride(host) && host?.fontFamily ? host.fontFamily : defaultFontFamilyId;

export const resolveHostTerminalFontSize = (host: Host | null | undefined, defaultFontSize: number): number =>
  hasHostFontSizeOverride(host) && host?.fontSize != null ? host.fontSize : defaultFontSize;

