import { MessageSquare, Package } from 'lucide-react';
import React from 'react';
import type { AIQuickMessage, SlashCommandItem, UserSkillSlashOption } from '../../infrastructure/ai/quickMessages';
import { getSlashCommandItemId } from '../../infrastructure/ai/quickMessages';
import { ScrollArea } from '../ui/scroll-area';

export interface SlashCommandPickerProps {
  listboxId: string;
  ariaLabel: string;
  quickMessages: AIQuickMessage[];
  userSkills: UserSkillSlashOption[];
  slashCommandItems: SlashCommandItem[];
  activeMenuIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelectQuickMessage: (message: AIQuickMessage) => void;
  onSelectSkill: (skill: UserSkillSlashOption) => void;
  quickMessagesSectionLabel: string;
  userSkillsSectionLabel: string;
  noResultsLabel: string;
  emptyHintLabel?: string;
  className?: string;
  style?: React.CSSProperties;
  listRef?: React.Ref<HTMLDivElement>;
}

export const SlashCommandPicker: React.FC<SlashCommandPickerProps> = ({
  listboxId,
  ariaLabel,
  quickMessages,
  userSkills,
  slashCommandItems,
  activeMenuIndex,
  onActiveIndexChange,
  onSelectQuickMessage,
  onSelectSkill,
  quickMessagesSectionLabel,
  userSkillsSectionLabel,
  noResultsLabel,
  emptyHintLabel,
  className,
  style,
  listRef,
}) => {
  const activeItem = slashCommandItems[activeMenuIndex];
  const activeDescendantId = activeItem ? `${listboxId}-${getSlashCommandItemId(activeItem)}` : undefined;

  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendantId}
      className={className}
      style={style}
    >
      <ScrollArea className="max-h-[280px]">
        <div className="p-1">
          {slashCommandItems.length === 0 ? (
            <div className="px-3 py-4 text-center space-y-1">
              <p className="text-[12px] text-muted-foreground/70">{noResultsLabel}</p>
              {emptyHintLabel ? (
                <p className="text-[11px] text-muted-foreground/45 leading-relaxed">{emptyHintLabel}</p>
              ) : null}
            </div>
          ) : (
            <>
              {quickMessages.length > 0 ? (
                <>
                  <div className="px-2 py-1 text-[10px] text-muted-foreground/40 tracking-wide">
                    {quickMessagesSectionLabel}
                  </div>
                  {quickMessages.map((message) => {
                    const idx = slashCommandItems.findIndex(
                      (item) => item.kind === 'quickMessage' && item.message.id === message.id,
                    );
                    const isActive = idx === activeMenuIndex;
                    return (
                      <button
                        id={`${listboxId}-${message.id}`}
                        key={message.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => onActiveIndexChange(idx)}
                        onClick={() => onSelectQuickMessage(message)}
                        className={`w-full rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${isActive ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
                      >
                        <div className="flex items-center gap-2 text-[12px] min-w-0">
                          <MessageSquare size={12} className="text-muted-foreground/55 shrink-0" />
                          <span className="text-foreground/90 truncate">{message.name}</span>
                          <span className="text-muted-foreground/45 font-mono shrink-0">/{message.slug}</span>
                        </div>
                        {(message.description || message.content) ? (
                          <div className="pl-5 text-[10px] leading-4.5 text-muted-foreground/62 line-clamp-2">
                            {message.description || message.content}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </>
              ) : null}
              {userSkills.length > 0 ? (
                <>
                  <div className="px-2 py-1 text-[10px] text-muted-foreground/40 tracking-wide">
                    {userSkillsSectionLabel}
                  </div>
                  {userSkills.map((skill) => {
                    const idx = slashCommandItems.findIndex(
                      (item) => item.kind === 'skill' && item.skill.id === skill.id,
                    );
                    const isActive = idx === activeMenuIndex;
                    return (
                      <button
                        id={`${listboxId}-${skill.id}`}
                        key={skill.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => onActiveIndexChange(idx)}
                        onClick={() => onSelectSkill(skill)}
                        className={`w-full rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${isActive ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
                      >
                        <div className="flex items-center gap-2 text-[12px]">
                          <Package size={12} className="text-muted-foreground/55 shrink-0" />
                          <span className="text-foreground/90">/{skill.slug}</span>
                        </div>
                        {skill.description ? (
                          <div className="pl-5 text-[10px] leading-4.5 text-muted-foreground/62 line-clamp-2">
                            {skill.description}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
