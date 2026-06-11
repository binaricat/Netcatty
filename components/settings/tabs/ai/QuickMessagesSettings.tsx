import { MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import type { AIQuickMessage } from "../../../../infrastructure/ai/quickMessages";
import {
  createQuickMessageId,
  isValidQuickMessageSlug,
  normalizeQuickMessageSlug,
  QUICK_MESSAGE_LIMITS,
  slugFromQuickMessageName,
} from "../../../../infrastructure/ai/quickMessages";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { SettingCard, SettingsSection } from "../../settings-ui";

interface QuickMessagesSettingsProps {
  quickMessages: AIQuickMessage[];
  setQuickMessages: (value: AIQuickMessage[] | ((prev: AIQuickMessage[]) => AIQuickMessage[])) => void;
  reservedUserSkillSlugs?: string[];
}

type DraftQuickMessage = {
  name: string;
  slug: string;
  content: string;
  description: string;
};

const emptyDraft = (): DraftQuickMessage => ({
  name: "",
  slug: "",
  content: "",
  description: "",
});

export const QuickMessagesSettings: React.FC<QuickMessagesSettingsProps> = ({
  quickMessages,
  setQuickMessages,
  reservedUserSkillSlugs = [],
}) => {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<DraftQuickMessage>(emptyDraft);
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedMessages = useMemo(
    () => [...quickMessages].sort((a, b) => a.name.localeCompare(b.name)),
    [quickMessages],
  );

  const resetEditor = useCallback(() => {
    setEditingId(null);
    setIsCreating(false);
    setDraft(emptyDraft());
    setSlugTouched(false);
    setError(null);
  }, []);

  const beginCreate = useCallback(() => {
    setEditingId(null);
    setIsCreating(true);
    setDraft(emptyDraft());
    setSlugTouched(false);
    setError(null);
  }, []);

  const beginEdit = useCallback((message: AIQuickMessage) => {
    setIsCreating(false);
    setEditingId(message.id);
    setDraft({
      name: message.name,
      slug: message.slug,
      content: message.content,
      description: message.description ?? "",
    });
    setSlugTouched(true);
    setError(null);
  }, []);

  const handleNameChange = useCallback((name: string) => {
    setDraft((prev) => ({
      ...prev,
      name,
      slug: slugTouched ? prev.slug : slugFromQuickMessageName(name),
    }));
  }, [slugTouched]);

  const handleSlugChange = useCallback((slug: string) => {
    setSlugTouched(true);
    setDraft((prev) => ({ ...prev, slug: normalizeQuickMessageSlug(slug) }));
  }, []);

  const validateDraft = useCallback((nextDraft: DraftQuickMessage, excludeId?: string | null): string | null => {
    const name = nextDraft.name.trim();
    const slug = normalizeQuickMessageSlug(nextDraft.slug);
    const content = nextDraft.content.trim();

    if (!name) return t("ai.quickMessages.error.nameRequired");
    if (!isValidQuickMessageSlug(slug)) return t("ai.quickMessages.error.invalidSlug");
    if (!content) return t("ai.quickMessages.error.contentRequired");

    if (!excludeId && quickMessages.length >= QUICK_MESSAGE_LIMITS.maxItems) {
      return t("ai.quickMessages.error.maxItems", { max: String(QUICK_MESSAGE_LIMITS.maxItems) });
    }

    const slugTaken = quickMessages.some(
      (message) => message.slug === slug && message.id !== excludeId,
    );
    if (slugTaken) return t("ai.quickMessages.error.slugTaken");

    const skillConflict = reservedUserSkillSlugs.some((skillSlug) => skillSlug === slug);
    if (skillConflict) {
      return t("ai.quickMessages.error.slugConflictsWithSkill", { slug });
    }

    return null;
  }, [quickMessages, reservedUserSkillSlugs, t]);

  const handleSave = useCallback(() => {
    const validationError = validateDraft(draft, editingId);
    if (validationError) {
      setError(validationError);
      return;
    }

    const payload: AIQuickMessage = {
      id: editingId ?? createQuickMessageId(),
      name: draft.name.trim(),
      slug: normalizeQuickMessageSlug(draft.slug),
      content: draft.content.trim(),
      description: draft.description.trim() || undefined,
    };

    if (editingId) {
      setQuickMessages((prev) => prev.map((message) => (
        message.id === editingId ? payload : message
      )));
    } else {
      setQuickMessages((prev) => [...prev, payload]);
    }
    resetEditor();
  }, [draft, editingId, resetEditor, setQuickMessages, validateDraft]);

  const handleDelete = useCallback((message: AIQuickMessage) => {
    const ok = window.confirm(t("ai.quickMessages.confirmDelete", { name: message.name }));
    if (!ok) return;
    setQuickMessages((prev) => prev.filter((item) => item.id !== message.id));
    if (editingId === message.id) {
      resetEditor();
    }
  }, [editingId, resetEditor, setQuickMessages, t]);

  const showEditor = isCreating || editingId != null;

  return (
    <SettingsSection
      title={t("ai.quickMessages.title")}
      actions={(
        <Button variant="outline" size="sm" onClick={beginCreate} disabled={showEditor}>
          <Plus size={14} className="mr-2" />
          {t("ai.quickMessages.add")}
        </Button>
      )}
    >
      <SettingCard padded className="space-y-3">
        <p className="text-xs text-muted-foreground/80 leading-5">
          {t("ai.quickMessages.description")}
        </p>

        {showEditor ? (
          <div className="rounded-md border border-border/60 bg-background/40 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">
                {isCreating ? t("ai.quickMessages.createTitle") : t("ai.quickMessages.editTitle")}
              </div>
              <button
                type="button"
                onClick={resetEditor}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
                aria-label={t("common.cancel")}
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="text-muted-foreground">{t("ai.quickMessages.name")}</span>
                <input
                  value={draft.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder={t("ai.quickMessages.name.placeholder")}
                  maxLength={QUICK_MESSAGE_LIMITS.name}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted-foreground">{t("ai.quickMessages.slug")}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground/70">/</span>
                  <input
                    value={draft.slug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    placeholder={t("ai.quickMessages.slug.placeholder")}
                    maxLength={QUICK_MESSAGE_LIMITS.slug}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  />
                </div>
              </label>
            </div>

            <label className="block space-y-1.5 text-sm">
              <span className="text-muted-foreground">{t("ai.quickMessages.descriptionField")}</span>
              <input
                value={draft.description}
                onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                placeholder={t("ai.quickMessages.descriptionField.placeholder")}
                maxLength={QUICK_MESSAGE_LIMITS.description}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>

            <label className="block space-y-1.5 text-sm">
              <span className="text-muted-foreground">{t("ai.quickMessages.content")}</span>
              <textarea
                value={draft.content}
                onChange={(e) => setDraft((prev) => ({ ...prev, content: e.target.value }))}
                placeholder={t("ai.quickMessages.content.placeholder")}
                rows={5}
                maxLength={QUICK_MESSAGE_LIMITS.content}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y min-h-[120px]"
              />
            </label>

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={resetEditor}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleSave}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : null}

        {sortedMessages.length > 0 ? (
          <div className="border-t border-border/60 divide-y divide-border/60">
            {sortedMessages.map((message) => (
              <div
                key={message.id}
                className="py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <MessageSquare size={14} className="text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium">{message.name}</span>
                      <span className="text-xs font-mono text-muted-foreground/80">/{message.slug}</span>
                    </div>
                    {message.description ? (
                      <p className="text-xs text-muted-foreground leading-5">{message.description}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground/70 line-clamp-2 whitespace-pre-wrap">
                      {message.content}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => beginEdit(message)}
                      aria-label={t("ai.quickMessages.editTitle")}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(message)}
                      aria-label={t("ai.quickMessages.confirmDelete", { name: message.name })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : !showEditor ? (
          <div className="border-t border-border/60 pt-3 text-sm text-muted-foreground">
            <p className="text-sm text-muted-foreground">{t("ai.quickMessages.empty")}</p>
          </div>
        ) : null}
      </SettingCard>
    </SettingsSection>
  );
};
