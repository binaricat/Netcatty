import { useCallback, useEffect, useMemo, useRef } from 'react';
import { activeTabStore, useActiveTabId } from './activeTabStore';
import { collectPluginVaultPages, PLUGIN_VAULT_PAGE_PREFIX, resolvePluginVaultPage } from './pluginVaultPages';
import { usePluginContributions } from './usePluginContributions';
import { OPEN_PLUGIN_VIEW_EVENT, type OpenPluginViewDetail } from './usePluginViewLifecycle';

const CONTEXT = Object.freeze({ 'netcatty.surface': 'vault-page' });

export function usePluginVaultPages({ locale, section, select }: {
  locale: string;
  section: string;
  select(section: 'hosts' | `plugin-vault:${string}`): void;
}) {
  const active = useActiveTabId() === 'vault';
  const sectionRef = useRef(section);
  const focusFrame = useRef<number | null>(null);
  sectionRef.current = section;
  useEffect(() => () => { if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current); }, []);
  const contributions = usePluginContributions({ locale, context: CONTEXT });
  const pages = useMemo(() => collectPluginVaultPages(contributions.snapshot.plugins), [contributions.snapshot.plugins]);
  const selected = resolvePluginVaultPage(pages, section);
  const fallback = useCallback(() => {
    select('hosts');
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (sectionRef.current === 'hosts' && activeTabStore.getActiveTabId() === 'vault') {
        document.querySelector<HTMLButtonElement>('[data-plugin-vault-fallback]')?.focus();
      }
    });
  }, [select]);
  useEffect(() => {
    if (!contributions.loading && section.startsWith(PLUGIN_VAULT_PAGE_PREFIX) && !selected) fallback();
  }, [contributions.loading, fallback, section, selected]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenPluginViewDetail>).detail;
      const page = pages.find((item) => item.viewId === detail?.viewId);
      if (!page) return;
      activeTabStore.setActiveTabId('vault');
      select(page.key);
    };
    window.addEventListener(OPEN_PLUGIN_VIEW_EVENT, open);
    return () => window.removeEventListener(OPEN_PLUGIN_VIEW_EVENT, open);
  }, [pages, select]);
  return { pages, selected, active, select, fallback, contributions, context: CONTEXT };
}
