import React, { useId, useState } from "react";
import {
  DEFAULT_RDP_HEIGHT,
  DEFAULT_RDP_WIDTH,
  parseRdpDimensionDraft,
  type RdpResolutionDraft,
} from "../../domain/remoteDesktop";
import type { Host, RdpConfig } from "../../types";
import { Input } from "../ui/input";

export interface RdpResolutionDraftProps {
  resolutionDraft?: RdpResolutionDraft;
  onResolutionDraftChange?: (dimension: "width" | "height", value: string) => void;
}

interface RdpResolutionFieldsProps extends RdpResolutionDraftProps {
  form: Pick<Host, "rdpConfig">;
  setForm: React.Dispatch<React.SetStateAction<Host>>;
  inheritedRdpConfig?: Partial<RdpConfig>;
  t: (key: string) => string;
}

export const RdpResolutionFields: React.FC<RdpResolutionFieldsProps> = ({
  form, setForm, inheritedRdpConfig, t, resolutionDraft, onResolutionDraftChange,
}) => {
  const [localDraft, setLocalDraft] = useState<RdpResolutionDraft>({});
  const id = useId();
  const draft = resolutionDraft ?? localDraft;

  return (
    <div className="grid grid-cols-2 gap-2">
      {(["width", "height"] as const).map((dimension) => {
        const value = draft[dimension] ?? String(
          form.rdpConfig?.[dimension]
          ?? inheritedRdpConfig?.[dimension]
          ?? (dimension === "width" ? DEFAULT_RDP_WIDTH : DEFAULT_RDP_HEIGHT),
        );
        const invalid = parseRdpDimensionDraft(value) === undefined;
        const inputId = `${id}-${dimension}`;
        return (
          <div key={dimension} className="space-y-1">
            <div className="flex items-center justify-between gap-2 bg-transparent px-1 h-10">
              <label htmlFor={inputId} className="text-sm font-medium text-foreground shrink-0">
                {t(`hostDetails.rdp.${dimension}`)}
              </label>
              <Input
                id={inputId}
                type="text"
                inputMode="numeric"
                value={value}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${inputId}-hint` : undefined}
                onChange={(e) => {
                  const next = e.target.value;
                  if (onResolutionDraftChange) onResolutionDraftChange(dimension, next);
                  else setLocalDraft((prev) => ({ ...prev, [dimension]: next }));
                  const parsed = parseRdpDimensionDraft(next);
                  if (parsed !== undefined) {
                    setForm((prev) => ({
                      ...prev,
                      rdpConfig: { ...prev.rdpConfig, [dimension]: parsed },
                    }));
                  }
                }}
                className="h-8 w-20 text-sm text-center font-mono"
              />
            </div>
            {invalid && (
              <p id={`${inputId}-hint`} className="px-1 text-xs text-destructive">
                {t("hostDetails.rdp.dimensionHint")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};
