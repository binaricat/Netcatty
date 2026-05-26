import React from "react";
import { cn } from "../../../../lib/utils";
import type { ProviderConfig } from "../../../../infrastructure/ai/types";
import type { SettingsIconId } from "./types";
import {
  BUILTIN_PROVIDER_ICON_BY_ID,
  SETTINGS_ICON_PATHS,
  SETTINGS_ICON_COLORS,
} from "./types";

/**
 * Optional ProviderConfig-like shape for per-provider customization. Only the
 * fields used by the badge are listed so non-provider call sites (Claude/Copilot
 * agent cards) can still pass a bare `providerId`.
 */
type ProviderLike = Pick<ProviderConfig, "providerId" | "name" | "iconId" | "iconDataUrl">;

interface BaseProps {
  size?: "xs" | "sm" | "md";
}

type Props =
  | (BaseProps & { providerId: SettingsIconId; provider?: undefined })
  | (BaseProps & { provider: ProviderLike; providerId?: undefined });

const BADGE_DIMENSIONS = {
  xs: "w-4 h-4",
  sm: "w-5 h-5",
  md: "w-8 h-8",
} as const;

const IMG_DIMENSIONS = {
  xs: "w-2.5 h-2.5",
  sm: "w-3 h-3",
  md: "w-4 h-4",
} as const;

const UPLOAD_IMG_DIMENSIONS = {
  xs: "w-4 h-4",
  sm: "w-5 h-5",
  md: "w-8 h-8",
} as const;

export const ProviderIconBadge: React.FC<Props> = (props) => {
  const size = props.size ?? "md";
  const dim = BADGE_DIMENSIONS[size];

  // Branch 1: user-uploaded data URL — render verbatim, no filter, neutral bg.
  if (props.provider?.iconDataUrl) {
    return (
      <div className={cn("rounded-md flex items-center justify-center shrink-0 overflow-hidden bg-zinc-900/40", dim)}>
        <img
          src={props.provider.iconDataUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={cn("object-contain", UPLOAD_IMG_DIMENSIONS[size])}
        />
      </div>
    );
  }

  // Branch 2: built-in iconId (lobe-icons subset).
  const iconId = props.provider?.iconId;
  if (iconId) {
    const builtin = BUILTIN_PROVIDER_ICON_BY_ID[iconId];
    if (builtin) {
      return (
        <div className={cn("rounded-md flex items-center justify-center shrink-0 overflow-hidden", dim, builtin.bgColor)}>
          <img
            src={builtin.path}
            alt=""
            aria-hidden="true"
            draggable={false}
            className={cn("object-contain brightness-0 invert", IMG_DIMENSIONS[size])}
          />
        </div>
      );
    }
  }

  // Branch 3: providerId → existing built-in fallback table.
  const fallbackId: SettingsIconId | undefined =
    props.providerId ?? (props.provider ? (props.provider.providerId as SettingsIconId) : undefined);
  if (fallbackId && fallbackId in SETTINGS_ICON_PATHS) {
    return (
      <div className={cn("rounded-md flex items-center justify-center shrink-0 overflow-hidden", dim, SETTINGS_ICON_COLORS[fallbackId])}>
        <img
          src={SETTINGS_ICON_PATHS[fallbackId]}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={cn(
            "object-contain",
            fallbackId === "copilot" ? "brightness-0" : "brightness-0 invert",
            IMG_DIMENSIONS[size],
          )}
        />
      </div>
    );
  }

  // Branch 4: letter avatar from the provider name.
  const letter = (props.provider?.name?.trim().charAt(0) ?? "?").toUpperCase();
  return (
    <div
      className={cn(
        "rounded-md flex items-center justify-center shrink-0 overflow-hidden bg-zinc-600 text-white font-medium",
        dim,
        size === "md" ? "text-sm" : size === "sm" ? "text-[10px]" : "text-[9px]",
      )}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
};
