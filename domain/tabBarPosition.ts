export type TabBarPosition = 'top' | 'bottom';

export function normalizeTabBarPosition(value: unknown): TabBarPosition {
  return value === 'bottom' ? 'bottom' : 'top';
}
