import { Search, X } from "lucide-react";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { filterSettingsSearchCatalog, type SettingsSearchHit } from "../../domain/settingsSearch";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { useSettingsFocus } from "./SettingsFocusContext";

type SettingsSearchControlProps = {
  includePlugins?: boolean;
  className?: string;
};

export function SettingsSearchControl({
  includePlugins = true,
  className,
}: SettingsSearchControlProps) {
  const { t } = useI18n();
  const { requestFocus, registerOpenSearch } = useSettingsFocus();
  const listId = useId();
  const optionIdPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [restoreOpenFocus, setRestoreOpenFocus] = useState(false);

  const hits = useMemo(
    () => filterSettingsSearchCatalog(query, t, { includePlugins, limit: 12 }),
    [query, t, includePlugins],
  );

  const collapseSearch = useCallback((restoreFocus = false) => {
    setExpanded(false);
    setQuery("");
    if (restoreFocus) setRestoreOpenFocus(true);
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, hits.length]);

  useEffect(() => {
    const open = () => {
      setExpanded(true);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    registerOpenSearch(open);
    return () => registerOpenSearch(null);
  }, [registerOpenSearch]);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        collapseSearch(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        collapseSearch(true);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded, collapseSearch]);

  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
      return;
    }
    if (restoreOpenFocus) {
      openButtonRef.current?.focus();
      setRestoreOpenFocus(false);
    }
  }, [expanded, restoreOpenFocus]);

  const selectHit = (hit: SettingsSearchHit) => {
    requestFocus({
      tab: hit.entry.tab,
      aiSubTab: hit.entry.aiSubTab,
      syncSubTab: hit.entry.syncSubTab,
      anchorId: hit.entry.id,
    });
    collapseSearch(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Avoid stealing IME candidate navigation / composition confirm (CJK).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (hits.length === 0) return;
      setActiveIndex((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (hits.length === 0) return;
      setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[activeIndex];
      if (hit) selectHit(hit);
    }
  };

  const activeOptionId = hits[activeIndex]
    ? `${optionIdPrefix}-${hits[activeIndex].entry.id}`
    : undefined;

  if (!expanded) {
    return (
      <div className={cn("px-0 pb-2", className)} ref={rootRef}>
        <button
          id="settings-search-open"
          ref={openButtonRef}
          type="button"
          onClick={() => setExpanded(true)}
          className={cn(
            "app-no-drag flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm",
            "text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground",
          )}
          aria-label={t("settings.search.open")}
          title={t("settings.search.open")}
        >
          <Search size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{t("settings.search.open")}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={cn("relative px-0 pb-2", className)} ref={rootRef}>
      <div className="app-no-drag relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("settings.search.placeholder")}
          aria-label={t("settings.search.placeholder")}
          aria-controls={listId}
          aria-expanded={true}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={activeOptionId}
          role="combobox"
          className="h-9 pl-8 pr-8 text-sm"
        />
        <button
          type="button"
          onClick={() => collapseSearch(true)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("common.close")}
        >
          <X size={14} />
        </button>
      </div>

      <div
        id={listId}
        role="listbox"
        className={cn(
          "absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-72 overflow-y-auto",
          "rounded-md border border-border bg-popover text-popover-foreground shadow-md",
        )}
      >
        {hits.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            {t("settings.search.noResults")}
          </div>
        ) : (
          hits.map((hit, index) => {
            const path = [hit.tabLabel, hit.section].filter(Boolean).join(" · ");
            return (
              <button
                key={hit.entry.id}
                id={`${optionIdPrefix}-${hit.entry.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors",
                  index === activeIndex ? "bg-primary/15" : "hover:bg-muted/50",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectHit(hit)}
              >
                <span className="text-sm font-medium text-foreground">{hit.label}</span>
                {path ? (
                  <span className="text-[11px] text-muted-foreground">{path}</span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
