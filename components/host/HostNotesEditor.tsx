import { FileText } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { MessageResponse } from "../ai-elements/message";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/utils";

const PREVIEW_PROSE_CLASS =
  "text-sm text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

function defaultNotesTab(notes: string): "edit" | "preview" {
  return notes.trim() ? "preview" : "edit";
}

export interface HostNotesEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Changes when opening a different host (e.g. host id) to reset the active tab */
  panelKey?: string;
  className?: string;
}

export const HostNotesEditor: React.FC<HostNotesEditorProps> = ({
  value,
  onChange,
  panelKey,
  className,
}) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<"edit" | "preview">(() => defaultNotesTab(value));

  useEffect(() => {
    if (panelKey === undefined) return;
    setTab(defaultNotesTab(value));
    // Only reset tab when opening another host, not while editing notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value read on panelKey change
  }, [panelKey]);

  const trimmed = value.trim();

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-muted-foreground shrink-0" />
        <p className="text-xs font-semibold text-muted-foreground">
          {t("hostDetails.notes.label")}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{t("hostDetails.notes.help")}</p>
      <Tabs value={tab} onValueChange={(v) => setTab(v as "edit" | "preview")}>
        <TabsList className="h-8 w-full">
          <TabsTrigger value="edit" className="flex-1 text-xs">
            {t("hostDetails.notes.tab.edit")}
          </TabsTrigger>
          <TabsTrigger value="preview" className="flex-1 text-xs">
            {t("hostDetails.notes.tab.preview")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="edit" className="mt-2">
          <Textarea
            placeholder={t("hostDetails.notes.placeholder")}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-[120px] text-sm"
            rows={5}
          />
        </TabsContent>
        <TabsContent value="preview" className="mt-2">
          <ScrollArea className="h-[120px] rounded-md border border-border/60 bg-muted/20 p-3">
            {trimmed ? (
              <MessageResponse className={PREVIEW_PROSE_CLASS}>{trimmed}</MessageResponse>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("hostDetails.notes.preview.empty")}
              </p>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
};
