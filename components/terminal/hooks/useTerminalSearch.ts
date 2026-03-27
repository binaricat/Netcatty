import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

type SearchMatchCount = { current: number; total: number } | null;

const SEARCH_DECORATIONS = {
  matchBackground: "#FFFF0044",
  matchBorder: "#FFFF00",
  matchOverviewRuler: "#FFFF00",
  activeMatchBackground: "#FF880088",
  activeMatchBorder: "#FF8800",
  activeMatchColorOverviewRuler: "#FF8800",
} as const;

const SEARCH_OPTIONS = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  decorations: SEARCH_DECORATIONS,
} as const;

export const useTerminalSearch = ({
  searchAddonRef,
  termRef,
}: {
  searchAddonRef: RefObject<SearchAddon | null>;
  termRef: RefObject<XTerm | null>;
}) => {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchMatchCount, setSearchMatchCount] = useState<SearchMatchCount>(null);
  const searchTermRef = useRef<string>("");

  const clearSearchDecorations = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
  }, [searchAddonRef]);

  const handleToggleSearch = useCallback(() => {
    setIsSearchOpen((prev) => !prev);
    if (isSearchOpen) {
      setSearchMatchCount(null);
      clearSearchDecorations();
    }
  }, [clearSearchDecorations, isSearchOpen]);

  const handleSearch = useCallback(
    (term: string): boolean => {
      const searchAddon = searchAddonRef.current;
      if (!searchAddon || !term) {
        setSearchMatchCount(null);
        return false;
      }

      searchTermRef.current = term;
      searchAddon.clearDecorations();

      const found = searchAddon.findNext(term, SEARCH_OPTIONS);

      if (found) {
        setSearchMatchCount({ current: 1, total: 1 });
      } else {
        setSearchMatchCount({ current: 0, total: 0 });
      }

      return found;
    },
    [searchAddonRef],
  );

  const handleFindNext = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    return searchAddon.findNext(term, SEARCH_OPTIONS);
  }, [searchAddonRef]);

  const handleFindPrevious = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    return searchAddon.findPrevious(term, SEARCH_OPTIONS);
  }, [searchAddonRef]);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchMatchCount(null);
    clearSearchDecorations();
    termRef.current?.focus();
  }, [clearSearchDecorations, termRef]);

  return {
    isSearchOpen,
    setIsSearchOpen,
    searchMatchCount,
    handleToggleSearch,
    handleSearch,
    handleFindNext,
    handleFindPrevious,
    handleCloseSearch,
  };
};
