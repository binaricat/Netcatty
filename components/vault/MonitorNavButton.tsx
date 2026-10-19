import React from "react";
import { Gauge } from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import { RippleButton } from "../ui/ripple";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
export function MonitorNavButton({
  active,
  collapsed,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RippleButton
          variant={active ? "secondary" : "ghost"}
          onClick={onClick}
          aria-label={t("monitor.title")}
          className={cn(
            "w-full h-10",
            collapsed ? "justify-center p-0" : "justify-start gap-3",
            active &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
          )}
        >
          <Gauge size={16} className="shrink-0" />
          {!collapsed && <span>{t("monitor.title")}</span>}
        </RippleButton>
      </TooltipTrigger>
      <TooltipContent side="right">{t("monitor.title")}</TooltipContent>
    </Tooltip>
  );
}
