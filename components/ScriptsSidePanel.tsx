/**
 * ScriptsSidePanel - Lightweight scripts browser for the terminal side panel
 *
 * Shows snippets organized by package hierarchy with breadcrumb navigation.
 * Clicking a snippet executes it in the focused terminal session.
 */

import { ChevronRight, Package, Plus, Search, Zap } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { cn } from '../lib/utils';
import { Snippet } from '../types';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';

interface ScriptsSidePanelProps {
  snippets: Snippet[];
  packages: string[];
  onSnippetClick: (command: string, noAutoRun?: boolean) => void;
  isVisible?: boolean;
}

const ScriptsSidePanelInner: React.FC<ScriptsSidePanelProps> = ({
  snippets,
  packages,
  onSnippetClick,
  isVisible = true,
}) => {
  const { t } = useI18n();
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const displayedPackages = useMemo(() => {
    if (!selectedPackage) {
      const absolutePaths = packages.filter(p => p.startsWith('/'));
      const relativePaths = packages.filter(p => !p.startsWith('/'));

      const results: { name: string; path: string; count: number }[] = [];

      const relativeRoots = relativePaths
        .map((p) => p.split('/')[0])
        .filter((name): name is string => Boolean(name) && name.length > 0);

      Array.from(new Set(relativeRoots)).forEach((name: string) => {
        const path: string = name;
        const count = snippets.filter((s) => {
          const pkg = s.package || '';
          return pkg === path || pkg.startsWith(path + '/');
        }).length;
        results.push({ name, path, count });
      });

      const absoluteRoots = absolutePaths
        .map((p) => {
          const cleanPath = p.substring(1);
          return cleanPath.split('/')[0];
        })
        .filter((name): name is string => Boolean(name) && name.length > 0);

      Array.from(new Set(absoluteRoots)).forEach((name: string) => {
        const path: string = `/${name}`;
        const displayName: string = `/${name}`;
        const count = snippets.filter((s) => {
          const pkg = s.package || '';
          return pkg === path || pkg.startsWith(path + '/');
        }).length;
        results.push({ name: displayName, path, count });
      });

      return results;
    }

    const prefix = selectedPackage + '/';
    const children = packages
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').split('/')[0])
      .filter((name): name is string => Boolean(name) && name.length > 0);
    return Array.from(new Set(children)).map((name) => {
      const path = `${selectedPackage}/${name}`;
      const count = snippets.filter((s) => {
        const pkg = s.package || '';
        return pkg === path || pkg.startsWith(path + '/');
      }).length;
      return { name, path, count };
    });
  }, [packages, selectedPackage, snippets]);

  const displayedSnippets = useMemo(() => {
    let result = snippets.filter((s) => (s.package || '') === (selectedPackage || ''));
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(sn =>
        sn.label.toLowerCase().includes(s) ||
        sn.command.toLowerCase().includes(s)
      );
    }
    return result;
  }, [snippets, selectedPackage, search]);

  // Also filter packages by search when at root level
  const filteredPackages = useMemo(() => {
    if (!search.trim()) return displayedPackages;
    const s = search.toLowerCase();
    return displayedPackages.filter(pkg => pkg.name.toLowerCase().includes(s));
  }, [displayedPackages, search]);

  const breadcrumb = useMemo(() => {
    if (!selectedPackage) return [];
    const isAbsolute = selectedPackage.startsWith('/');
    const parts = selectedPackage.split('/').filter(Boolean);
    return parts.map((name, idx) => {
      const pathSegments = parts.slice(0, idx + 1);
      const path = isAbsolute ? `/${pathSegments.join('/')}` : pathSegments.join('/');
      return { name, path };
    });
  }, [selectedPackage]);

  const handleSnippetClick = useCallback((command: string, noAutoRun?: boolean) => {
    onSnippetClick(command, noAutoRun);
  }, [onSnippetClick]);

  const handleAddSnippet = useCallback(() => {
    // Let the App shell listen and navigate to the Snippets section with
    // the "add" panel pre-opened, so the user does not have to leave the
    // terminal to jump back and click "New Snippet".
    window.dispatchEvent(new CustomEvent('netcatty:snippets:add'));
  }, []);

  if (!isVisible) return null;

  const hasAnyContent = snippets.length > 0 || packages.length > 0;

  return (
    <div
      className="h-full flex flex-col bg-background overflow-hidden"
      data-section="snippets-panel"
    >
      {/* Search + Add */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border/50 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('snippets.searchPlaceholder')}
            className="h-7 pl-7 text-xs bg-muted/30 border-none"
          />
        </div>
        <button
          type="button"
          onClick={handleAddSnippet}
          title={t('snippets.action.newSnippet')}
          aria-label={t('snippets.action.newSnippet')}
          className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 text-[11px] border-b border-border/30 min-h-[28px]">
        <button
          className={cn(
            "hover:text-primary transition-colors truncate",
            !selectedPackage ? "text-foreground font-medium" : "text-muted-foreground"
          )}
          onClick={() => setSelectedPackage(null)}
        >
          {t('terminal.toolbar.library')}
        </button>
        {breadcrumb.map((b) => (
          <React.Fragment key={b.path}>
            <ChevronRight size={10} className="text-muted-foreground shrink-0" />
            <button
              className="text-muted-foreground hover:text-primary transition-colors truncate"
              onClick={() => setSelectedPackage(b.path)}
            >
              {b.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {!hasAnyContent && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Zap size={24} className="opacity-40 mb-2" />
              <span className="text-xs">{t('terminal.toolbar.noSnippets')}</span>
            </div>
          )}

          {/* Packages */}
          {filteredPackages.map((pkg) => (
            <button
              key={pkg.path}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
              onClick={() => { setSelectedPackage(pkg.path); setSearch(''); }}
            >
              <div className="w-6 h-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Package size={12} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{pkg.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {t('snippets.package.count', { count: pkg.count })}
                </div>
              </div>
              <ChevronRight size={12} className="text-muted-foreground shrink-0" />
            </button>
          ))}

          {/* Snippets */}
          {displayedSnippets.map((s) => (
            <button
              key={s.id}
              onClick={() => handleSnippetClick(s.command, s.noAutoRun)}
              className="w-full text-left px-3 py-2 hover:bg-accent/50 transition-colors flex flex-col gap-0.5"
            >
              <span className="text-xs font-medium truncate">{s.label}</span>
              <span className="text-muted-foreground truncate font-mono text-[10px] max-w-full">
                {s.command}
              </span>
            </button>
          ))}

          {hasAnyContent && displayedSnippets.length === 0 && filteredPackages.length === 0 && search.trim() && (
            <div className="px-3 py-4 text-xs text-muted-foreground italic text-center">
              {t('common.noResultsFound')}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export const ScriptsSidePanel = memo(ScriptsSidePanelInner);
ScriptsSidePanel.displayName = 'ScriptsSidePanel';
