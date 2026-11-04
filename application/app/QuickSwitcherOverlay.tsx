import React, { Suspense, lazy, useMemo, useState } from 'react';

import type { QuickSwitcherProps } from '../../components/QuickSwitcher';
import { LazyLoadBoundary } from '../../components/ui/lazy-load-boundary';
import { getHostSearchMatch } from '../../lib/searchMatcher';
import type { Host } from '../../types';

const LazyQuickSwitcher = lazy(() =>
  import('../../components/QuickSwitcher').then((m) => ({ default: m.QuickSwitcher })),
);

/** Hosts matching the quick switcher query, best match first. */
export function filterQuickSwitcherHosts(hosts: Host[], query: string): Host[] {
  const term = query.trim();
  if (!term) return hosts;
  return hosts
    .map((host) => ({ host, match: getHostSearchMatch(term, host) }))
    .filter((entry) => entry.match.matched)
    .sort((left, right) => {
      if (left.match.score !== right.match.score) {
        return right.match.score - left.match.score;
      }
      return left.host.label.localeCompare(right.host.label);
    })
    .map((entry) => entry.host);
}

export type QuickSwitcherOverlayProps =
  Omit<QuickSwitcherProps, 'query' | 'results' | 'onQueryChange'> & { hosts: Host[] };

/**
 * Owns the quick switcher query. It used to live in AppSideEffects and travel
 * through the app-local UI store, so every keystroke re-rendered the whole
 * shell (AppSideEffects, every host island, AppShell, AppView and TopTabs).
 * The overlay is only mounted while the switcher is open, so closing it resets
 * the query just like the old `setQuickSearch('')` calls did.
 */
export function QuickSwitcherOverlay({ hosts, ...props }: QuickSwitcherOverlayProps) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => filterQuickSwitcherHosts(hosts, query), [hosts, query]);
  return (
    <LazyLoadBoundary name="Quick switcher" resetKey={query}>
      <Suspense fallback={null}>
        <LazyQuickSwitcher {...props} query={query} results={results} onQueryChange={setQuery} />
      </Suspense>
    </LazyLoadBoundary>
  );
}
