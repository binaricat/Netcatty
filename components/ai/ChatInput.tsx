/**
 * ChatInput - Zed-style bottom input area for the AI chat panel
 *
 * Thin wrapper around the AI Elements prompt-input components.
 * Bordered textarea with monospace placeholder, expand toggle,
 * and a bottom toolbar with muted controls + subtle send button.
 */

import { AtSign, Check, ChevronDown, ChevronRight, Cpu, Expand, Eye, FileText, ImageIcon, Package, Plus, ShieldCheck, X, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '../ai-elements/prompt-input';
import type { PromptInputStatus } from '../ai-elements/prompt-input';
import { formatThinkingLabel } from '../../infrastructure/ai/types';
import type { AgentModelPreset, AIPermissionMode, UploadedFile } from '../../infrastructure/ai/types';
import { ScrollArea } from '../ui/scroll-area';

// Keep in sync with the popover's Tailwind max-width below.
const MODEL_PICKER_MAX_WIDTH = 360;

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  providerName?: string;
  modelName?: string;
  agentName?: string;
  placeholder?: string;
  /** Available model presets for the current agent */
  modelPresets?: AgentModelPreset[];
  /** Currently selected model ID */
  selectedModelId?: string;
  /** Callback when user selects a model */
  onModelSelect?: (modelId: string) => void;
  /** Attached files (images, PDFs, etc.) */
  files?: UploadedFile[];
  /** Callback to add files (paste/drop) */
  onAddFiles?: (files: File[]) => void;
  /** Callback to remove a file */
  onRemoveFile?: (id: string) => void;
  /** Available hosts for @ mention */
  hosts?: Array<{ sessionId: string; hostname: string; label: string; connected: boolean }>;
  /** User skills currently selected for the next send */
  selectedUserSkills?: Array<{ id: string; slug: string; name: string; description: string }>;
  /** Available user skills for /skill-slug insertion */
  userSkills?: Array<{ id: string; slug: string; name: string; description: string }>;
  /** Callback to add a selected user skill */
  onAddUserSkill?: (slug: string) => void;
  /** Callback to remove a selected user skill */
  onRemoveUserSkill?: (slug: string) => void;
  /** Permission mode (only shown for Catty Agent) */
  permissionMode?: AIPermissionMode;
  /** Callback when user changes permission mode */
  onPermissionModeChange?: (mode: AIPermissionMode) => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming = false,
  disabled = false,
  providerName,
  modelName,
  agentName,
  placeholder,
  modelPresets = [],
  selectedModelId,
  onModelSelect,
  files = [],
  onAddFiles,
  onRemoveFile,
  hosts = [],
  selectedUserSkills = [],
  userSkills = [],
  onAddUserSkill,
  onRemoveUserSkill,
  permissionMode,
  onPermissionModeChange,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // Consolidate menu state into a single discriminated union to prevent multiple menus open simultaneously
  type ActiveMenu = 'model' | 'attach' | 'atMention' | 'slashSkill' | 'perm' | null;
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const [inputPanelPos, setInputPanelPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashRange, setSlashRange] = useState<{ start: number; end: number } | null>(null);
  // Active highlight index for @ mention / slash skill keyboard navigation
  const [activeMenuIndex, setActiveMenuIndex] = useState(0);

  // Derived booleans for readability
  const showModelPicker = activeMenu === 'model';
  const showAttachMenu = activeMenu === 'attach';
  const showAtMention = activeMenu === 'atMention';
  const showSlashSkillPicker = activeMenu === 'slashSkill';
  const showPermPicker = activeMenu === 'perm';

  const closeAllMenus = useCallback(() => {
    setActiveMenu(null);
    setMenuPos(null);
    setInputPanelPos(null);
    setHoveredModelId(null);
    setSlashQuery('');
    setSlashRange(null);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputShellRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const permBtnRef = useRef<HTMLButtonElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const findSlashTrigger = useCallback((text: string, caretPosition: number) => {
    const beforeCaret = text.slice(0, caretPosition);
    const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(beforeCaret);
    if (!match) return null;
    const start = beforeCaret.length - match[0].length + match[1].length;
    return {
      start,
      end: beforeCaret.length,
      query: String(match[2] || '').toLowerCase(),
    };
  }, []);

  const getInputPanelMenuPos = useCallback(() => {
    const rect = inputShellRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const horizontalMargin = 12;
    const safeRight = window.innerWidth - horizontalMargin;
    const width = Math.min(rect.width, safeRight - rect.left);
    return {
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8,
      width,
    };
  }, []);

  const handleInputChange = useCallback((newValue: string) => {
    onChange(newValue);
    const caretPosition = textareaRef.current?.selectionStart ?? newValue.length;
    // Detect if user just typed @
    if (
      hosts.length > 0 &&
      newValue.length > value.length &&
      newValue.endsWith('@')
    ) {
      // Position the popover near the textarea
      const pos = getInputPanelMenuPos();
      if (pos) setInputPanelPos(pos);
      setActiveMenu('atMention');
      return;
    }

    const slashTrigger = findSlashTrigger(newValue, caretPosition);
    if (userSkills.length > 0 && slashTrigger) {
      const pos = getInputPanelMenuPos();
      if (pos) setInputPanelPos(pos);
      setSlashQuery(slashTrigger.query);
      setSlashRange({ start: slashTrigger.start, end: slashTrigger.end });
      setActiveMenu('slashSkill');
      return;
    }

    if (showAtMention && !newValue.includes('@')) {
      setActiveMenu(null);
    } else if (showSlashSkillPicker) {
      closeAllMenus();
    }
  }, [onChange, value, hosts.length, showAtMention, findSlashTrigger, userSkills.length, showSlashSkillPicker, closeAllMenus, getInputPanelMenuPos]);

  const handleSelectAtMention = useCallback((host: { label: string; hostname: string }) => {
    // Replace the trailing @ with @hostname
    const name = host.label || host.hostname;
    const lastAt = value.lastIndexOf('@');
    const newValue = lastAt >= 0
      ? value.slice(0, lastAt) + `@${name} `
      : value + `@${name} `;
    onChange(newValue);
    closeAllMenus();
  }, [value, onChange, closeAllMenus]);

  const openInputPanelMenu = useCallback((menu: 'atMention' | 'slashSkill') => {
    const pos = getInputPanelMenuPos();
    if (!pos) return;
    setInputPanelPos(pos);
    if (menu === 'slashSkill') {
      setSlashQuery('');
      setSlashRange(null);
    }
    setActiveMenu(menu);
  }, [getInputPanelMenuPos]);

  const filteredUserSkills = useMemo(() => userSkills.filter((skill) => {
    if (!slashQuery) return true;
    const lowerQuery = slashQuery.toLowerCase();
    return skill.slug.toLowerCase().startsWith(lowerQuery) || skill.name.toLowerCase().includes(lowerQuery);
  }), [userSkills, slashQuery]);

  const removeSlashQueryFromInput = useCallback(() => {
    if (!slashRange) return value;
    const before = value.slice(0, slashRange.start);
    const after = value.slice(slashRange.end);
    if (/\s$/.test(before) && /^\s/.test(after)) {
      return `${before}${after.slice(1)}`;
    }
    return `${before}${after}`;
  }, [slashRange, value]);

  const insertUserSkillToken = useCallback((skill: { slug: string }) => {
    onAddUserSkill?.(skill.slug);
    if (slashRange) {
      onChange(removeSlashQueryFromInput());
    }
    closeAllMenus();
  }, [closeAllMenus, onAddUserSkill, onChange, removeSlashQueryFromInput, slashRange]);

  // Reset active highlight when a menu opens or when the *identity* of the
  // visible items changes. Watching only `.length` misses cases where the
  // filter produces a different set with the same count (e.g. user types
  // another character into the slash query) — Enter would then commit an
  // unexpected item. Derive a stable key from the visible ids instead.
  const atMentionKey = useMemo(
    () => hosts.map((h) => h.sessionId).join('|'),
    [hosts],
  );
  const slashSkillKey = useMemo(
    () => filteredUserSkills.map((s) => s.id).join('|'),
    [filteredUserSkills],
  );
  useEffect(() => {
    if (showAtMention) setActiveMenuIndex(0);
  }, [showAtMention, atMentionKey]);
  useEffect(() => {
    if (showSlashSkillPicker) setActiveMenuIndex(0);
  }, [showSlashSkillPicker, slashSkillKey]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // @ mention popover keyboard navigation
    if (showAtMention && hosts.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMenuIndex((i) => (i + 1) % hosts.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMenuIndex((i) => (i - 1 + hosts.length) % hosts.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const host = hosts[Math.min(activeMenuIndex, hosts.length - 1)];
        if (host) handleSelectAtMention(host);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAllMenus();
        return;
      }
    }
    // / skill popover keyboard navigation
    if (showSlashSkillPicker && filteredUserSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMenuIndex((i) => (i + 1) % filteredUserSkills.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMenuIndex((i) => (i - 1 + filteredUserSkills.length) % filteredUserSkills.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const skill = filteredUserSkills[Math.min(activeMenuIndex, filteredUserSkills.length - 1)];
        if (skill) insertUserSkillToken(skill);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAllMenus();
        return;
      }
    }
  }, [showAtMention, hosts, showSlashSkillPicker, filteredUserSkills, activeMenuIndex, handleSelectAtMention, insertUserSkillToken, closeAllMenus]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pastedFiles = Array.from(e.clipboardData.items)
      .map((item: DataTransferItem) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      onAddFiles?.(pastedFiles);
    }
  }, [onAddFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      onAddFiles?.(droppedFiles);
    }
  }, [onAddFiles]);

  const defaultPlaceholder = agentName
    ? t('ai.chat.placeholder').replace('{agent}', agentName)
    : t('ai.chat.placeholderDefault');

  const handleSubmit = useCallback(
    (_text: string, _event: FormEvent<HTMLFormElement>) => {
      onSend();
    },
    [onSend],
  );

  const status: PromptInputStatus = isStreaming ? 'streaming' : 'idle';

  // Permission mode chip removed — agents run in autonomous mode

  // selectedModelId may be "<modelId>/<thinkingLevel>" for codex ChatGPT models
  // (e.g. "gpt-5.4/high"). Note: custom config.toml / OpenRouter model ids
  // themselves can contain '/' (e.g. "qwen/qwen3.6-plus"), so don't just
  // split on the first '/'. Match against the full id first; only treat the
  // trailing segment as a thinking level when we find a preset whose
  // declared thinkingLevels make the combined form equal to selectedModelId.
  const { selectedPreset, selectedThinking } = (() => {
    if (!selectedModelId) return { selectedPreset: undefined, selectedThinking: undefined };
    const direct = modelPresets.find(m => m.id === selectedModelId);
    if (direct) return { selectedPreset: direct, selectedThinking: undefined };
    const viaThinking = modelPresets.find(
      m => m.thinkingLevels?.some(level => `${m.id}/${level}` === selectedModelId),
    );
    if (viaThinking) {
      const thinking = selectedModelId.slice(viaThinking.id.length + 1);
      return { selectedPreset: viaThinking, selectedThinking: thinking };
    }
    return { selectedPreset: undefined, selectedThinking: undefined };
  })();
  const selectedBaseModelId = selectedPreset?.id;
  const modelLabel = selectedPreset
    ? selectedPreset.name + (selectedThinking ? ` / ${formatThinkingLabel(selectedThinking)}` : '')
    : modelName || providerName || t('ai.chat.noModel');
  const hasModelPicker = modelPresets.length > 0 && onModelSelect;
  const chipClassName =
    'inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[10.5px] text-foreground/72';
  const selectedSkillChipClassName =
    'inline-flex h-7 items-center gap-1.5 rounded-full border border-primary/18 bg-primary/8 pl-2.5 pr-1.5 text-[11px] font-medium text-foreground/86 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';
  const iconButtonClassName =
    'h-6 w-6 rounded-full bg-transparent text-foreground/62 hover:bg-muted/24 hover:text-foreground';

  return (
    <div className="shrink-0 px-4 pb-4">
      <div ref={inputShellRef} className="relative">
      <PromptInput onSubmit={handleSubmit}>
        {/* File attachment chips */}
        {files.length > 0 && (
          <div className="flex gap-1.5 px-3 pt-2 pb-0.5 flex-wrap">
            {files.map((file) => (
              <div
                key={file.id}
                className="inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md bg-muted/30 border border-border/30 text-[11px] text-foreground/70 group"
              >
                {file.mediaType.startsWith('image/') ? (
                  <ImageIcon size={11} className="text-muted-foreground/60 shrink-0" />
                ) : (
                  <FileText size={11} className="text-muted-foreground/60 shrink-0" />
                )}
                <span className="truncate max-w-[80px]">{file.filename}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile?.(file.id)}
                  className="h-3.5 w-3.5 rounded-sm flex items-center justify-center opacity-50 hover:opacity-100 hover:bg-muted/50 transition-opacity cursor-pointer"
                >
                  <X size={8} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              onAddFiles?.(Array.from(e.target.files));
              e.target.value = '';
            }
          }}
        />

        {/* Textarea with expand toggle */}
        <div className="relative" onPaste={handlePaste} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
          {selectedUserSkills.length > 0 && (
            <div className="px-3 pt-3 pb-1.5">
              <div className="flex flex-wrap gap-2">
                {selectedUserSkills.map((skill) => (
                  <div
                    key={skill.id}
                    className={selectedSkillChipClassName}
                    title={skill.description || skill.name || skill.slug}
                  >
                    <Package size={11} className="text-primary/72 shrink-0" />
                    <span className="truncate max-w-[180px]">
                      {skill.name && skill.name !== skill.slug ? skill.name : `/${skill.slug}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveUserSkill?.(skill.slug)}
                      className="inline-flex h-4.5 w-4.5 items-center justify-center rounded-full text-foreground/42 hover:bg-primary/10 hover:text-foreground/72 transition-colors cursor-pointer"
                      aria-label={`Remove skill ${skill.name || skill.slug}`}
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <PromptInputTextarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder={placeholder || defaultPlaceholder}
            disabled={disabled}
            className={[
              selectedUserSkills.length > 0 ? 'pt-1.5' : undefined,
              expanded ? 'max-h-[220px]' : undefined,
            ].filter(Boolean).join(' ')}
            maxLength={100000}
          />
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="absolute top-3.5 right-3 rounded-md p-1 text-muted-foreground/38 hover:text-muted-foreground/72 hover:bg-muted/25 transition-colors cursor-pointer"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <Expand size={12} />
          </button>
        </div>

        {/* @ mention popover */}
        {showAtMention && hosts.length > 0 && inputPanelPos && createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <div
              role="listbox"
              aria-label="Mention host"
              aria-activedescendant={hosts[activeMenuIndex] ? `at-mention-${hosts[activeMenuIndex].sessionId}` : undefined}
              className="fixed z-[1000] overflow-hidden rounded-lg border border-border/50 bg-popover shadow-lg"
              style={{ left: inputPanelPos.left, bottom: inputPanelPos.bottom, width: 'auto', minWidth: Math.min(200, inputPanelPos.width), maxWidth: inputPanelPos.width }}
            >
              <ScrollArea className="max-h-[280px]">
                <div className="p-1">
                  {hosts.map((host, idx) => {
                    const isActive = idx === activeMenuIndex;
                    const showHostnameLine = host.label
                      && host.hostname !== host.label
                      && !host.label.includes(host.hostname);
                    return (
                      <button
                        id={`at-mention-${host.sessionId}`}
                        key={host.sessionId}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveMenuIndex(idx)}
                        onClick={() => handleSelectAtMention(host)}
                        className={`w-full rounded-md px-2 py-1 text-left transition-colors cursor-pointer ${isActive ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
                      >
                        <div className="flex items-center gap-2 text-[12px] text-foreground/90">
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${host.connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                          <span className="truncate">{host.label || host.hostname}</span>
                        </div>
                        {showHostnameLine ? (
                          <div className="pl-3.5 text-[10px] text-muted-foreground/60 truncate">
                            {host.hostname}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </>,
          document.body,
        )}

        {/* / skill popover */}
        {showSlashSkillPicker && filteredUserSkills.length > 0 && inputPanelPos && createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
            <div
              role="listbox"
              aria-label="Insert user skill"
              aria-activedescendant={filteredUserSkills[activeMenuIndex] ? `slash-skill-${filteredUserSkills[activeMenuIndex].id}` : undefined}
              className="fixed z-[1000] overflow-hidden rounded-lg border border-border/50 bg-popover shadow-lg"
              style={{ left: inputPanelPos.left, bottom: inputPanelPos.bottom, width: 'auto', minWidth: Math.min(200, inputPanelPos.width), maxWidth: inputPanelPos.width }}
            >
              <ScrollArea className="max-h-[280px]">
                <div className="p-1">
                  {filteredUserSkills.map((skill, idx) => {
                    const isActive = idx === activeMenuIndex;
                    return (
                      <button
                        id={`slash-skill-${skill.id}`}
                        key={skill.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveMenuIndex(idx)}
                        onClick={() => insertUserSkillToken(skill)}
                        className={`w-full rounded-md px-2 py-1 text-left transition-colors cursor-pointer ${isActive ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
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
                </div>
              </ScrollArea>
            </div>
          </>,
          document.body,
        )}

        {/* Footer toolbar */}
        <PromptInputFooter className="gap-1.5 border-t-0 bg-transparent px-3 pb-2 pt-0">
          <PromptInputTools className="gap-1 flex-wrap">
            <button
              ref={attachBtnRef}
              type="button"
              onClick={() => {
                if (!showAttachMenu) {
                  const rect = attachBtnRef.current?.getBoundingClientRect();
                  if (rect) setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
                  setActiveMenu('attach');
                } else {
                  closeAllMenus();
                }
              }}
              className={iconButtonClassName}
              title="Attach"
              aria-label="Attach file"
              aria-expanded={showAttachMenu}
            >
              <Plus size={13} />
            </button>
            {showAttachMenu && menuPos && createPortal(
              <>
                <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
                <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
                <div
                  role="menu"
                  className="fixed z-[1000] min-w-[170px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: menuPos.left, bottom: menuPos.bottom }}
                >
                  <div className="px-3 py-1 text-[10px] text-muted-foreground/40 tracking-wide">{t('ai.chat.menuContext')}</div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { fileInputRef.current?.setAttribute('accept', '*/*'); fileInputRef.current?.click(); closeAllMenus(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <FileText size={13} className="text-muted-foreground/60" />
                    <span className="text-foreground/85">{t('ai.chat.menuFiles')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { fileInputRef.current?.setAttribute('accept', 'image/*'); fileInputRef.current?.click(); closeAllMenus(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <ImageIcon size={13} className="text-muted-foreground/60" />
                    <span className="text-foreground/85">{t('ai.chat.menuImage')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Mention host"
                    onClick={() => openInputPanelMenu('atMention')}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <AtSign size={13} className="text-muted-foreground/60" />
                    <span className="flex-1 text-foreground/85">{t('ai.chat.menuMentionHost')}</span>
                    {hosts.length > 0 && <ChevronRight size={10} className="text-muted-foreground/50" />}
                  </button>
                  {userSkills.length > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="Insert user skill"
                      onClick={() => openInputPanelMenu('slashSkill')}
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Package size={13} className="text-muted-foreground/60" />
                      <span className="flex-1 text-foreground/85">{t('ai.chat.menuUserSkills')}</span>
                      <ChevronRight size={10} className="text-muted-foreground/50" />
                    </button>
                  )}
                </div>
              </>,
              document.body,
            )}
            <button
              ref={modelBtnRef}
              type="button"
              onClick={() => {
                if (!hasModelPicker) return;
                if (!showModelPicker) {
                  const rect = modelBtnRef.current?.getBoundingClientRect();
                  if (rect) {
                    // Clamp so the popover stays inside the viewport when
                    // the chip is near the right edge of a narrow AI side
                    // panel.
                    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MODEL_PICKER_MAX_WIDTH - 8));
                    setMenuPos({ left, bottom: window.innerHeight - rect.top + 6 });
                  }
                  setActiveMenu('model');
                } else {
                  closeAllMenus();
                }
              }}
              className={`${chipClassName} ${hasModelPicker ? 'cursor-pointer hover:bg-muted/24 transition-colors' : ''}`}
              aria-label="Select model"
              aria-expanded={showModelPicker}
            >
              <Cpu size={11} className="text-muted-foreground/64" />
              <span className="truncate max-w-[82px]">{modelLabel}</span>
              {hasModelPicker && <ChevronDown size={9} className="text-muted-foreground/50" />}
            </button>
            {showModelPicker && hasModelPicker && menuPos && createPortal(
<>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
            <div
              role="listbox"
                  aria-label="Select model"
                  className="fixed z-[1000] w-max min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: menuPos.left, bottom: menuPos.bottom, maxWidth: MODEL_PICKER_MAX_WIDTH }}
                  onMouseLeave={() => setHoveredModelId(null)}
                >
                  {modelPresets.map(preset => {
                    const isSelected = preset.id === selectedBaseModelId;
                    const hasThinking = preset.thinkingLevels && preset.thinkingLevels.length > 0;
                    return (
                      <div
                        key={preset.id}
                        className="relative"
                        onMouseEnter={() => setHoveredModelId(hasThinking ? preset.id : null)}
                        onFocus={() => { if (hasThinking) setHoveredModelId(preset.id); }}
                        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHoveredModelId(null); }}
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => {
                            if (!hasThinking) {
                              onModelSelect?.(preset.id);
                              closeAllMenus();
                            }
                          }}
                          className="w-full min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer"
                        >
                          {isSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                          <span className="flex-1 min-w-0 truncate text-foreground/85">{preset.name}</span>
                          {hasThinking && <ChevronRight size={10} className="text-muted-foreground/50 shrink-0" />}
                        </button>
                        {/* Thinking level sub-menu */}
                        {hasThinking && hoveredModelId === preset.id && (
                          <div role="listbox" aria-label="Thinking level" className="absolute left-full top-0 ml-1 min-w-[120px] rounded-lg border border-border/50 bg-popover shadow-lg py-1 z-[1001]">
                            {preset.thinkingLevels!.map(level => {
                              const fullId = `${preset.id}/${level}`;
                              const isLevelSelected = selectedModelId === fullId;
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  role="option"
                                  aria-selected={isLevelSelected}
                                  tabIndex={0}
                                  onClick={() => {
                                    onModelSelect?.(fullId);
                                    closeAllMenus();
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      onModelSelect?.(fullId);
                                      closeAllMenus();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      closeAllMenus();
                                    }
                                  }}
                                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  {isLevelSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                                  <span className="text-foreground/85">{formatThinkingLabel(level)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>,
              document.body,
            )}
            {/* Permission mode chip — only for Catty Agent */}
            {permissionMode && onPermissionModeChange && (
              <>
                <button
                  ref={permBtnRef}
                  type="button"
                  onClick={() => {
                    if (!showPermPicker) {
                      const rect = permBtnRef.current?.getBoundingClientRect();
                      if (rect) setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
                      setActiveMenu('perm');
                    } else {
                      closeAllMenus();
                    }
                  }}
                  className={`${chipClassName} cursor-pointer hover:bg-muted/24 transition-colors`}
                  title={t('ai.safety.permissionMode')}
                  aria-label="Permission mode"
                  aria-expanded={showPermPicker}
                >
                  {permissionMode === 'observer' && <Eye size={11} className="text-blue-400/70" />}
                  {permissionMode === 'confirm' && <ShieldCheck size={11} className="text-yellow-400/70" />}
                  {permissionMode === 'autonomous' && <Zap size={11} className="text-green-400/70" />}
                  <span className="truncate max-w-[72px]">
                    {permissionMode === 'observer' && t('ai.chat.permObserver')}
                    {permissionMode === 'confirm' && t('ai.chat.permConfirm')}
                    {permissionMode === 'autonomous' && t('ai.chat.permAuto')}
                  </span>
                  <ChevronDown size={9} className="text-muted-foreground/50" />
                </button>
                {showPermPicker && menuPos && createPortal(
                  <>
                    <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
                    <div className="fixed inset-0 z-[999] cursor-default" onClick={closeAllMenus} />
                    <div
                      role="listbox"
                      aria-label="Permission mode"
                      className="fixed z-[1000] min-w-[180px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                      style={{ left: menuPos.left, bottom: menuPos.bottom }}
                    >
                      {([
                        { mode: 'autonomous' as const, icon: Zap, color: 'text-green-400/70', label: t('ai.chat.permAuto'), desc: t('ai.chat.permAutoDesc') },
                        { mode: 'confirm' as const, icon: ShieldCheck, color: 'text-yellow-400/70', label: t('ai.chat.permConfirm'), desc: t('ai.chat.permConfirmDesc') },
                        { mode: 'observer' as const, icon: Eye, color: 'text-blue-400/70', label: t('ai.chat.permObserver'), desc: t('ai.chat.permObserverDesc') },
                      ]).map(({ mode, icon: Icon, color, label, desc }) => (
                        <button
                          key={mode}
                          type="button"
                          role="option"
                          aria-selected={permissionMode === mode}
                          onClick={() => {
                            onPermissionModeChange(mode);
                            closeAllMenus();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer"
                        >
                          {permissionMode === mode
                            ? <Check size={11} className="text-primary shrink-0" />
                            : <span className="w-[11px] shrink-0" />
                          }
                          <Icon size={12} className={`${color} shrink-0`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-foreground/85">{label}</div>
                            <div className="text-[10px] text-muted-foreground/40 leading-tight">{desc}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body,
                )}
              </>
            )}
          </PromptInputTools>

          <div className="flex-1 min-w-0" />

          <div className="flex items-center gap-1">
            <PromptInputSubmit
              status={status}
              onStop={onStop}
              disabled={!value.trim() || disabled}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>
    </div>
  );
};

export default React.memo(ChatInput);
