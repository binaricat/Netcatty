export const APP_ICON_VARIANTS = [
  'original',
  'bright',
  'dark',
  'colorful',
  'high-contrast',
  'white-navy',
  'white-sky',
  'white-rose',
  'white-emerald',
  'white-amber',
  'white-violet',
  'rainbow',
] as const;

export type AppIconVariant = (typeof APP_ICON_VARIANTS)[number];

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = 'original';

export function isValidAppIconVariant(value: unknown): value is AppIconVariant {
  return typeof value === 'string' && (APP_ICON_VARIANTS as readonly string[]).includes(value);
}

export function resolveAppIconVariant(value: unknown): AppIconVariant {
  return isValidAppIconVariant(value) ? value : DEFAULT_APP_ICON_VARIANT;
}
