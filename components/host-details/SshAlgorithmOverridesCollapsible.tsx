import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { HostAlgorithmOverrides } from "../../domain/models";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { AlgorithmOverridesPanel } from "./AlgorithmOverridesPanel";

export interface SshAlgorithmOverridesCollapsibleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: HostAlgorithmOverrides | undefined;
  legacyEnabled: boolean;
  inheritedFromGroup?: HostAlgorithmOverrides;
  onChange: (next: HostAlgorithmOverrides | undefined) => void;
  t: (key: string) => string;
}

export const SshAlgorithmOverridesCollapsible: React.FC<SshAlgorithmOverridesCollapsibleProps> = ({
  open,
  onOpenChange,
  value,
  legacyEnabled,
  inheritedFromGroup,
  onChange,
  t,
}) => (
  <Collapsible open={open} onOpenChange={onOpenChange}>
    <CollapsibleTrigger asChild>
      <Button
        variant="ghost"
        className="w-full justify-between h-8 px-2 hover:bg-accent/50"
      >
        <span className="text-xs font-medium text-muted-foreground">
          {t("hostDetails.algorithms.advanced")}
          {value && Object.keys(value).length > 0 && (
            <span className="ml-1.5 text-[10px] text-yellow-600 dark:text-yellow-400">
              ({t("hostDetails.algorithms.customized")})
            </span>
          )}
        </span>
        {open
          ? <ChevronUp size={14} className="text-muted-foreground" />
          : <ChevronDown size={14} className="text-muted-foreground" />}
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="mt-2">
      <AlgorithmOverridesPanel
        value={value}
        legacyEnabled={legacyEnabled}
        inheritedFromGroup={inheritedFromGroup}
        onChange={onChange}
      />
    </CollapsibleContent>
  </Collapsible>
);
