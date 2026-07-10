import {
  APP_ICON_VARIANTS,
  DEFAULT_APP_ICON_VARIANT,
  type AppIconVariant,
} from '../../domain/appIconVariant';

export { APP_ICON_VARIANTS, DEFAULT_APP_ICON_VARIANT, type AppIconVariant };

export const APP_ICON_VARIANT_ASSET_PATH: Record<AppIconVariant, string> = {
  original: '/icons/variants/original.png',
  bright: '/icons/variants/bright.png',
  dark: '/icons/variants/dark.png',
  colorful: '/icons/variants/colorful.png',
  'high-contrast': '/icons/variants/high-contrast.png',
  'white-navy': '/icons/variants/white-navy.png',
  'white-sky': '/icons/variants/white-sky.png',
  'white-rose': '/icons/variants/white-rose.png',
  'white-emerald': '/icons/variants/white-emerald.png',
  'white-amber': '/icons/variants/white-amber.png',
  'white-violet': '/icons/variants/white-violet.png',
  rainbow: '/icons/variants/rainbow.png',
};

export const APP_ICON_VARIANT_I18N_KEY: Record<AppIconVariant, string> = {
  original: 'settings.appearance.appIcon.original',
  bright: 'settings.appearance.appIcon.bright',
  dark: 'settings.appearance.appIcon.dark',
  colorful: 'settings.appearance.appIcon.colorful',
  'high-contrast': 'settings.appearance.appIcon.highContrast',
  'white-navy': 'settings.appearance.appIcon.whiteNavy',
  'white-sky': 'settings.appearance.appIcon.whiteSky',
  'white-rose': 'settings.appearance.appIcon.whiteRose',
  'white-emerald': 'settings.appearance.appIcon.whiteEmerald',
  'white-amber': 'settings.appearance.appIcon.whiteAmber',
  'white-violet': 'settings.appearance.appIcon.whiteViolet',
  rainbow: 'settings.appearance.appIcon.rainbow',
};

export const APP_ICON_VARIANT_GROUPS: Array<{
  id: 'classic' | 'white' | 'special';
  labelKey: string;
  variants: AppIconVariant[];
}> = [
  {
    id: 'classic',
    labelKey: 'settings.appearance.appIcon.group.classic',
    variants: ['original', 'bright', 'dark', 'colorful', 'high-contrast'],
  },
  {
    id: 'white',
    labelKey: 'settings.appearance.appIcon.group.white',
    variants: ['white-navy', 'white-sky', 'white-rose', 'white-emerald', 'white-amber', 'white-violet'],
  },
  {
    id: 'special',
    labelKey: 'settings.appearance.appIcon.group.special',
    variants: ['rainbow'],
  },
];
