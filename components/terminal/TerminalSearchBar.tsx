/**
 * Terminal Search Bar
 * Provides search functionality within terminal scrollback buffer
 */
import { ChevronUp, ChevronDown, Search } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '../ui/button';

export interface TerminalSearchBarProps {
    isOpen: boolean;
    onClose: () => void;
    onSearch: (term: string) => boolean;
    onFindNext: () => boolean;
    onFindPrevious: () => boolean;
    matchCount?: { current: number; total: number } | null;
}

export const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({
    isOpen,
    onClose,
    onSearch,
    onFindNext,
    onFindPrevious,
    matchCount,
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const prevSearchTermRef = useRef('');

    // Focus input when opened
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isOpen]);

    // Trigger search when term changes
    useEffect(() => {
        if (searchTerm !== prevSearchTermRef.current) {
            prevSearchTermRef.current = searchTerm;
            if (searchTerm.length > 0) {
                onSearch(searchTerm);
            }
        }
    }, [searchTerm, onSearch]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                onFindPrevious();
            } else {
                onFindNext();
            }
        } else if (e.key === 'F3' || (e.key === 'g' && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            if (e.shiftKey) {
                onFindPrevious();
            } else {
                onFindNext();
            }
        }
    }, [onClose, onFindNext, onFindPrevious]);

    if (!isOpen) return null;

    return (
        <div
            className="flex items-center gap-1.5 px-2 pt-1 pb-2 bg-black/50 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {/* Search input */}
            <div className="relative flex-1">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/40" />
                <input
                    ref={inputRef}
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    placeholder="Search..."
                    className="w-full h-6 pl-7 pr-2 text-[11px] bg-white/5 border-none rounded text-white placeholder:text-white/30 focus:outline-none focus:bg-white/10"
                />
            </div>

            {/* Match count indicator - only show when no results */}
            {searchTerm.length > 0 && matchCount?.total === 0 && (
                <span className="text-[10px] text-white/50 flex-shrink-0">
                    No results
                </span>
            )}

            {/* Navigation buttons */}
            <div className="flex items-center gap-0.5 flex-shrink-0">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onFindPrevious();
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    disabled={!searchTerm}
                    title="Previous match (Shift+Enter)"
                >
                    <ChevronUp size={14} />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onFindNext();
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    disabled={!searchTerm}
                    title="Next match (Enter)"
                >
                    <ChevronDown size={14} />
                </Button>
            </div>
        </div>
    );
};
