/**
 * ChatInput - Zed-style bottom input area for the AI chat panel
 *
 * Thin wrapper around the AI Elements prompt-input components.
 * Bordered textarea with monospace placeholder, expand toggle,
 * and a bottom toolbar with muted controls + subtle send button.
 */

import { AtSign, Check, ChevronDown, ChevronRight, Cpu, Expand, Eye, FileText, ImageIcon, Plus, ShieldCheck, X, Zap } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import type { UploadedFile } from '../../application/state/useFileUpload';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '../ai-elements/prompt-input';
import type { PromptInputStatus } from '../ai-elements/prompt-input';
import { formatThinkingLabel } from '../../infrastructure/ai/types';
import type { AgentModelPreset, AIPermissionMode } from '../../infrastructure/ai/types';

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
  permissionMode,
  onPermissionModeChange,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // Consolidate menu state into a single discriminated union to prevent multiple menus open simultaneously
  type ActiveMenu = 'model' | 'attach' | 'atMention' | 'perm' | null;
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const [showHostSubmenu, setShowHostSubmenu] = useState(false);

  // Derived booleans for readability
  const showModelPicker = activeMenu === 'model';
  const showAttachMenu = activeMenu === 'attach';
  const showAtMention = activeMenu === 'atMention';
  const showPermPicker = activeMenu === 'perm';

  const closeAllMenus = useCallback(() => {
    setActiveMenu(null);
    setMenuPos(null);
    setHoveredModelId(null);
    setShowHostSubmenu(false);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const permBtnRef = useRef<HTMLButtonElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleInputChange = useCallback((newValue: string) => {
    onChange(newValue);
    // Detect if user just typed @
    if (
      hosts.length > 0 &&
      newValue.length > value.length &&
      newValue.endsWith('@')
    ) {
      // Position the popover near the textarea
      const el = textareaRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        setMenuPos({ left: rect.left + 12, bottom: window.innerHeight - rect.top + 4 });
      }
      setActiveMenu('atMention');
    } else if (showAtMention && !newValue.includes('@')) {
      setActiveMenu(null);
    }
  }, [onChange, value, hosts.length, showAtMention]);

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

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pastedFiles = Array.from(e.clipboardData.items)
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[];
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

  // selectedModelId may be "model/thinking" for codex
  const selectedBaseModelId = selectedModelId?.split('/')[0];
  const selectedThinking = selectedModelId?.includes('/') ? selectedModelId.split('/')[1] : undefined;
  const selectedPreset = modelPresets.find(m => m.id === selectedBaseModelId);
  const modelLabel = selectedPreset
    ? selectedPreset.name + (selectedThinking ? ` / ${formatThinkingLabel(selectedThinking)}` : '')
    : modelName || providerName || t('ai.chat.noModel');
  const hasModelPicker = modelPresets.length > 0 && onModelSelect;
  const chipClassName =
    'inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[10.5px] text-foreground/72';
  const iconButtonClassName =
    'h-6 w-6 rounded-full bg-transparent text-foreground/62 hover:bg-muted/24 hover:text-foreground';

  return (
    <div className="shrink-0 px-4 pb-4">
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
          <PromptInputTextarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={placeholder || defaultPlaceholder}
            disabled={disabled || isStreaming}
            className={expanded ? 'max-h-[220px]' : undefined}
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
        {showAtMention && hosts.length > 0 && menuPos && createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={closeAllMenus} />
            <div
              role="listbox"
              aria-label="Mention host"
              className="fixed z-[1000] min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
              style={{ left: menuPos.left, bottom: menuPos.bottom }}
            >
              <div className="px-3 py-1 text-[10px] text-muted-foreground/40 tracking-wide">{t('ai.chat.menuHosts')}</div>
              {hosts.map(host => (
                <button
                  key={host.sessionId}
                  type="button"
                  role="option"
                  onClick={() => handleSelectAtMention(host)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${host.connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                  <span className="text-foreground/85 truncate">{host.label || host.hostname}</span>
                  {host.label && host.hostname !== host.label && (
                    <span className="text-[10px] text-muted-foreground/40">{host.hostname}</span>
                  )}
                </button>
              ))}
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
                  <div
                    className="relative"
                    onMouseEnter={() => setShowHostSubmenu(true)}
                    onMouseLeave={() => setShowHostSubmenu(false)}
                    onFocus={() => setShowHostSubmenu(true)}
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setShowHostSubmenu(false); }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="Mention host"
                      aria-expanded={showHostSubmenu && hosts.length > 0}
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <AtSign size={13} className="text-muted-foreground/60" />
                      <span className="flex-1 text-foreground/85">{t('ai.chat.menuMentionHost')}</span>
                      {hosts.length > 0 && <ChevronRight size={10} className="text-muted-foreground/50" />}
                    </button>
                    {showHostSubmenu && hosts.length > 0 && (
                      <div role="menu" className="absolute left-full top-0 ml-1 min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1 z-[1001]">
                        {hosts.map(host => (
                          <button
                            key={host.sessionId}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              const mention = `@${host.label || host.hostname} `;
                              onChange(value + mention);
                              closeAllMenus();
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                          >
                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${host.connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                            <span className="text-foreground/85 truncate">{host.label || host.hostname}</span>
                            {host.label && host.hostname !== host.label && (
                              <span className="text-[10px] text-muted-foreground/40">{host.hostname}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
                  if (rect) setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
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
                <div
                  role="listbox"
                  aria-label="Select model"
                  className="fixed z-[1000] min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: menuPos.left, bottom: menuPos.bottom }}
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
                          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          {isSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                          <span className="flex-1 text-foreground/85">{preset.name}</span>
                          {preset.description && <span className="text-[10px] text-muted-foreground/50 mr-1">{preset.description}</span>}
                          {hasThinking && <ChevronRight size={10} className="text-muted-foreground/50" />}
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
  );
};

export default React.memo(ChatInput);
