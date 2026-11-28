import { useEffect, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

const EMPTY_BADGES: ReadonlyMap<string, NetcattyPluginViewBadge> = new Map();

function buildBadgeMap(
  badges: ReadonlyArray<NetcattyPluginViewBadge> | null | undefined,
): ReadonlyMap<string, NetcattyPluginViewBadge> {
  if (!Array.isArray(badges) || badges.length === 0) return EMPTY_BADGES;
  const map = new Map<string, NetcattyPluginViewBadge>();
  for (const badge of badges) {
    if (badge && typeof badge.viewId === 'string' && badge.viewId.length > 0) {
      map.set(badge.viewId, badge);
    }
  }
  return map.size > 0 ? map : EMPTY_BADGES;
}

export function usePluginViewBadges(enabled = true): ReadonlyMap<string, NetcattyPluginViewBadge> {
  const [badgesByViewId, setBadgesByViewId] = useState<ReadonlyMap<string, NetcattyPluginViewBadge>>(EMPTY_BADGES);

  useEffect(() => {
    if (!enabled) {
      setBadgesByViewId(EMPTY_BADGES);
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.listPluginViewBadges && !bridge?.onPluginViewBadgesChanged) {
      setBadgesByViewId(EMPTY_BADGES);
      return;
    }
    let active = true;
    let receivedPush = false;
    const unsubscribe = bridge.onPluginViewBadgesChanged?.((badges) => {
      if (!active) return;
      receivedPush = true;
      setBadgesByViewId(buildBadgeMap(badges));
    });
    void bridge.listPluginViewBadges?.().then((badges) => {
      if (!active || receivedPush) return;
      setBadgesByViewId(buildBadgeMap(badges));
    }).catch(() => {
      if (!active || receivedPush) return;
      setBadgesByViewId(EMPTY_BADGES);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [enabled]);

  return badgesByViewId;
}
