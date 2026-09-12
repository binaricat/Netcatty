import { ListTree, X } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { extractNoteHeadings, type NoteHeadingItem } from "../../domain/notes";
import { useI18n } from "../../application/i18n/I18nProvider";

export interface NoteOutlineProps {
  content: string;
  onSelectHeading?: (heading: NoteHeadingItem, index: number) => void;
  onClose?: () => void;
  className?: string;
}

export const NoteOutline: React.FC<NoteOutlineProps> = ({
  content,
  onSelectHeading,
  onClose,
  className = "",
}) => {
  const { t } = useI18n();
  const headings = useMemo(() => extractNoteHeadings(content), [content]);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const minimumHeadingLevel = useMemo(
    () => headings.length > 0
      ? Math.min(...headings.map((heading) => heading.level))
      : 1,
    [headings],
  );

  useEffect(() => {
    setActiveHeadingId(null);
  }, [content]);

  return (
    <nav
      aria-label={t("notes.outline.title")}
      data-note-outline="true"
      className={`flex h-full flex-col bg-background select-none ${className}`}
    >
      <div className="flex shrink-0 items-center justify-between px-3.5 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground/90">
          <ListTree size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{t("notes.outline.title")}</span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground/60">
            {headings.length}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {headings.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            <p>{t("notes.outline.empty")}</p>
            <p className="mt-1 text-[11px] opacity-70">
              {t("notes.outline.emptyHint")}
            </p>
          </div>
        ) : (
          headings.map((item, index) => (
            <button
              key={item.id}
              type="button"
              data-note-outline-item={item.id}
              data-heading-level={item.level}
              className={`flex w-full items-center rounded-md py-1.5 pr-2 text-left text-xs leading-5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ${
                activeHeadingId === item.id
                  ? "bg-secondary/60 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
              }`}
              style={{ paddingLeft: `${10 + Math.min(item.level - minimumHeadingLevel, 4) * 12}px` }}
              onClick={() => {
                setActiveHeadingId(item.id);
                onSelectHeading?.(item, index);
              }}
              title={item.text}
            >
              <span className="truncate">{item.text}</span>
            </button>
          ))
        )}
      </div>
    </nav>
  );
};
