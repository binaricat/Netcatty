import { Host } from './models';

type TerminalAppearanceDefaults = {
  themeId: string;
  fontFamilyId: string;
  fontSize: number;
};

export const hasHostThemeOverride = (host?: Pick<Host, 'themeOverride'> | null): boolean =>
  host?.themeOverride === true;

export const hasHostFontFamilyOverride = (host?: Pick<Host, 'fontFamilyOverride'> | null): boolean =>
  host?.fontFamilyOverride === true;

export const hasHostFontSizeOverride = (host?: Pick<Host, 'fontSizeOverride'> | null): boolean =>
  host?.fontSizeOverride === true;

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

export const resolveHostTerminalAppearance = (
  host: Host | null | undefined,
  defaults: TerminalAppearanceDefaults,
) => ({
  themeId: resolveHostTerminalThemeId(host, defaults.themeId),
  fontFamilyId: resolveHostTerminalFontFamilyId(host, defaults.fontFamilyId),
  fontSize: resolveHostTerminalFontSize(host, defaults.fontSize),
  hasThemeOverride: hasHostThemeOverride(host),
  hasFontFamilyOverride: hasHostFontFamilyOverride(host),
  hasFontSizeOverride: hasHostFontSizeOverride(host),
});
