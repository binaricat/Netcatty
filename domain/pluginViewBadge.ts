export type PluginViewBadgeTone = 'default' | 'info' | 'warning' | 'danger';

export interface PluginViewBadgeDisplay {
  readonly viewId: string;
  readonly pluginId: string;
  readonly count?: number;
  readonly text?: string;
  readonly dot?: boolean;
  readonly tone: PluginViewBadgeTone;
  readonly tooltip?: string;
  readonly updatedAt?: number;
}

export function formatPluginViewBadgeLabel(
  badge: Pick<PluginViewBadgeDisplay, 'count' | 'text'> | null | undefined,
): string | null {
  if (!badge) return null;
  if (typeof badge.count === 'number' && Number.isFinite(badge.count) && badge.count > 0) {
    const normalized = Math.min(999, Math.floor(badge.count));
    return normalized > 99 ? '99+' : String(normalized);
  }
  if (typeof badge.text === 'string') {
    const trimmed = badge.text.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 4);
  }
  return null;
}

export function isPluginViewBadgeVisible(
  badge: PluginViewBadgeDisplay | null | undefined,
): badge is PluginViewBadgeDisplay {
  if (!badge) return false;
  return formatPluginViewBadgeLabel(badge) !== null || badge.dot === true;
}

export function formatPluginViewBadgeAriaText(
  badge: PluginViewBadgeDisplay | null | undefined,
): string | null {
  if (!isPluginViewBadgeVisible(badge)) return null;
  if (typeof badge.tooltip === 'string' && badge.tooltip.trim().length > 0) {
    return badge.tooltip.trim();
  }
  const label = formatPluginViewBadgeLabel(badge);
  if (label !== null) return label;
  return 'notification';
}
