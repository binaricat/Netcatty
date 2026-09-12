import {
  Copy,
  FileText,
  Share2,
} from "lucide-react";
import React, { useCallback, useState, useRef, useEffect } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import {
  type VaultNote,
} from "../../domain/notes";
import { copyToClipboard } from "../keychain/utils";
import { toast } from "../ui/toast";

export interface NoteExportMenuProps {
  note: VaultNote | null;
  allNotes: VaultNote[];
  onExportNote: (note: VaultNote) => void;
  onExportAll: () => void;
  className?: string;
}

export const NoteExportMenu: React.FC<NoteExportMenuProps> = ({
  note,
  allNotes,
  onExportNote,
  onExportAll,
  className = "",
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (e.key === "Tab") {
        setOpen(false);
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
      );
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = current;
      if (e.key === "ArrowDown") next = (current + 1 + items.length) % items.length;
      else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else return;
      e.preventDefault();
      items[next]?.focus();
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeAndRestoreFocus, open]);

  const handleExportSingleMarkdown = () => {
    if (!note) return;
    onExportNote(note);
    closeAndRestoreFocus();
  };

  const handleCopyMarkdown = async () => {
    if (!note) return;
    const ok = await copyToClipboard(note.content);
    if (ok) {
      toast.success(t("common.copied") || "已复制到剪贴板");
    }
    closeAndRestoreFocus();
  };

  const handleExportAllZip = () => {
    if (!allNotes.length) return;
    onExportAll();
    closeAndRestoreFocus();
  };

  return (
    <div className={`relative inline-block ${className}`} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        title={t("notes.export.share")}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Share2 size={16} />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 w-56 bg-popover border border-border rounded-lg shadow-lg py-1.5 z-50 text-sm animate-in fade-in-50 zoom-in-95">
          {note && (
            <>
              <div className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t("notes.export.currentNote")}
              </div>
              <button
                type="button"
                role="menuitem"
                className="w-full px-3 py-1.5 flex items-center gap-2.5 hover:bg-muted text-foreground transition-colors text-left"
                onClick={handleExportSingleMarkdown}
              >
                <FileText size={14} className="text-primary" />
                <span>{t("notes.export.exportMarkdown")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="w-full px-3 py-1.5 flex items-center gap-2.5 hover:bg-muted text-foreground transition-colors text-left"
                onClick={handleCopyMarkdown}
              >
                <Copy size={14} className="text-muted-foreground" />
                <span>{t("notes.export.copyMarkdown")}</span>
              </button>
              <div className="my-1 border-t border-border" />
            </>
          )}

          <div className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t("notes.export.allNotes")}
          </div>
          <button
            type="button"
            role="menuitem"
            className="w-full px-3 py-1.5 flex items-center gap-2.5 hover:bg-muted text-foreground transition-colors text-left"
            onClick={handleExportAllZip}
            disabled={!allNotes.length}
          >
            <FileText size={14} className="text-emerald-500" />
            <span>{t("notes.export.exportAllZip")}</span>
          </button>
        </div>
      )}
    </div>
  );
};
