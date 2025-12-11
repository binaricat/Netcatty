import React from 'react';
import { Check, ChevronDown, ChevronUp, Tag, Search, Pencil, Trash2, X } from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { Dropdown, DropdownContent, DropdownTrigger } from './dropdown';
import { ScrollArea } from './scroll-area';
import { cn } from '../../lib/utils';

interface TagFilterDropdownProps {
    allTags: string[];
    selectedTags: string[];
    onChange: (tags: string[]) => void;
    onEditTag?: (oldTag: string, newTag: string) => void;
    onDeleteTag?: (tag: string) => void;
    className?: string;
}

export const TagFilterDropdown: React.FC<TagFilterDropdownProps> = ({
    allTags,
    selectedTags,
    onChange,
    onEditTag,
    onDeleteTag,
    className,
}) => {
    const [open, setOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [editingTag, setEditingTag] = React.useState<string | null>(null);
    const [editValue, setEditValue] = React.useState('');
    const editInputRef = React.useRef<HTMLInputElement>(null);

    const toggleTag = (tag: string) => {
        if (selectedTags.includes(tag)) {
            onChange(selectedTags.filter(t => t !== tag));
        } else {
            onChange([...selectedTags, tag]);
        }
    };

    const clearAll = () => {
        onChange([]);
    };

    const hasFilters = selectedTags.length > 0;

    // Filter tags based on search query
    const filteredTags = React.useMemo(() => {
        if (!searchQuery.trim()) return allTags;
        const query = searchQuery.toLowerCase();
        return allTags.filter(tag => tag.toLowerCase().includes(query));
    }, [allTags, searchQuery]);

    // Start editing a tag
    const startEditing = (tag: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingTag(tag);
        setEditValue(tag);
        setTimeout(() => editInputRef.current?.focus(), 0);
    };

    // Save edited tag
    const saveEdit = () => {
        if (editingTag && editValue.trim() && editValue !== editingTag && onEditTag) {
            onEditTag(editingTag, editValue.trim());
            // Update selected tags if the edited tag was selected
            if (selectedTags.includes(editingTag)) {
                onChange(selectedTags.map(t => t === editingTag ? editValue.trim() : t));
            }
        }
        setEditingTag(null);
        setEditValue('');
    };

    // Cancel editing
    const cancelEdit = () => {
        setEditingTag(null);
        setEditValue('');
    };

    // Handle edit input key events
    const handleEditKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    };

    // Delete a tag
    const handleDelete = (tag: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (onDeleteTag) {
            onDeleteTag(tag);
            // Remove from selected tags if it was selected
            if (selectedTags.includes(tag)) {
                onChange(selectedTags.filter(t => t !== tag));
            }
        }
    };

    // Reset state when popover closes
    React.useEffect(() => {
        if (!open) {
            setSearchQuery('');
            setEditingTag(null);
            setEditValue('');
        }
    }, [open]);

    const canEdit = !!onEditTag;
    const canDelete = !!onDeleteTag;

    return (
        <Dropdown open={open} onOpenChange={setOpen}>
            <DropdownTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                        className || "h-8 w-8",
                        hasFilters && "text-primary"
                    )}
                >
                    <Tag size={14} />
                    {open ? <ChevronUp size={10} className="ml-0.5" /> : <ChevronDown size={10} className="ml-0.5" />}
                </Button>
            </DropdownTrigger>
            <DropdownContent className="w-64" align="end">
                {allTags.length === 0 ? (
                    <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                        No tags available
                    </div>
                ) : (
                    <>
                        {/* Search input */}
                        <div className="px-2 py-1.5">
                            <div className="relative">
                                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    placeholder="Search tags"
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="h-8 pl-7 text-sm"
                                />
                            </div>
                        </div>

                        {hasFilters && (
                            <Button
                                variant="ghost"
                                className="w-full justify-start gap-2 h-8 text-muted-foreground"
                                onClick={clearAll}
                            >
                                Clear selection
                            </Button>
                        )}

                        <div className="h-px bg-border my-1" />

                        <ScrollArea className="max-h-[240px]">
                            <div className="space-y-0.5">
                                {filteredTags.length === 0 ? (
                                    <div className="px-3 py-2 text-center text-sm text-muted-foreground">
                                        No matching tags
                                    </div>
                                ) : (
                                    filteredTags.map(tag => {
                                        const isSelected = selectedTags.includes(tag);
                                        const isEditing = editingTag === tag;

                                        if (isEditing) {
                                            return (
                                                <div key={tag} className="flex items-center gap-1 px-2 py-1">
                                                    <Input
                                                        ref={editInputRef}
                                                        value={editValue}
                                                        onChange={e => setEditValue(e.target.value)}
                                                        onKeyDown={handleEditKeyDown}
                                                        onBlur={saveEdit}
                                                        className="h-7 text-sm flex-1"
                                                        autoFocus
                                                    />
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 shrink-0"
                                                        onClick={cancelEdit}
                                                    >
                                                        <X size={12} />
                                                    </Button>
                                                </div>
                                            );
                                        }

                                        return (
                                            <div
                                                key={tag}
                                                className={cn(
                                                    "flex items-center gap-2 h-8 px-2 rounded-md cursor-pointer group",
                                                    isSelected ? "bg-secondary" : "hover:bg-muted/60"
                                                )}
                                                onClick={() => toggleTag(tag)}
                                            >
                                                <div
                                                    className={cn(
                                                        "h-3 w-3 rounded-full border shrink-0",
                                                        isSelected ? "bg-primary border-primary" : "border-muted-foreground"
                                                    )}
                                                />
                                                <span className="truncate flex-1 text-sm">{tag}</span>
                                                {isSelected && <Check size={12} className="shrink-0 text-primary" />}

                                                {/* Edit & Delete buttons - show on hover when handlers provided */}
                                                {(canEdit || canDelete) && (
                                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        {canEdit && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6"
                                                                onClick={(e) => startEditing(tag, e)}
                                                            >
                                                                <Pencil size={12} />
                                                            </Button>
                                                        )}
                                                        {canDelete && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6 text-destructive hover:text-destructive"
                                                                onClick={(e) => handleDelete(tag, e)}
                                                            >
                                                                <Trash2 size={12} />
                                                            </Button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </ScrollArea>
                    </>
                )}
            </DropdownContent>
        </Dropdown>
    );
};

export default TagFilterDropdown;
