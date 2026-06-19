import type { Host, HostIconColorId, HostIconId, HostIconMode } from "./models";

export const DEFAULT_HOST_ICON_ID: HostIconId = "server";
export const DEFAULT_HOST_ICON_COLOR: HostIconColorId = "blue";

export const HOST_ICON_IDS = [
  "server",
  "terminal",
  "database",
  "cloud",
  "router",
  "shield",
  "code",
  "box",
  "globe",
  "cpu",
  "hard-drive",
  "network",
  "wifi",
  "lock",
  "key",
  "monitor",
  "container",
  "activity",
  "zap",
  "server-cog",
] as const satisfies readonly HostIconId[];

export const HOST_ICON_COLORS = [
  { id: "blue", hex: "#2563EB" },
  { id: "green", hex: "#16A34A" },
  { id: "red", hex: "#DC2626" },
  { id: "amber", hex: "#B45309" },
  { id: "purple", hex: "#9333EA" },
  { id: "cyan", hex: "#0891B2" },
  { id: "orange", hex: "#EA580C" },
  { id: "slate", hex: "#475569" },
  { id: "violet", hex: "#7C3AED" },
  { id: "pink", hex: "#DB2777" },
  { id: "rose", hex: "#E11D48" },
  { id: "lime", hex: "#65A30D" },
  { id: "teal", hex: "#0D9488" },
  { id: "sky", hex: "#0284C7" },
  { id: "indigo", hex: "#4F46E5" },
  { id: "zinc", hex: "#52525B" },
] as const satisfies readonly { id: HostIconColorId; hex: string }[];

export type HostIconAppearance = {
  iconId: HostIconId;
  colorId: HostIconColorId;
  colorHex: string;
};

export type HostIconColorAppearance = {
  colorId: HostIconColorId;
  colorHex: string;
};

export const isHostIconMode = (value: unknown): value is HostIconMode =>
  value === "auto" || value === "custom";

export const isHostIconId = (value: unknown): value is HostIconId =>
  typeof value === "string" && (HOST_ICON_IDS as readonly string[]).includes(value);

export const isHostIconColorId = (value: unknown): value is HostIconColorId =>
  typeof value === "string" && HOST_ICON_COLORS.some((color) => color.id === value);

const resolveColorHex = (colorId: HostIconColorId): string =>
  HOST_ICON_COLORS.find((color) => color.id === colorId)?.hex || HOST_ICON_COLORS[0].hex;

export const resolveHostIconColorAppearance = (
  host: Partial<Pick<Host, "iconColor">>,
): HostIconColorAppearance | null => {
  if (!isHostIconColorId(host.iconColor)) return null;
  return {
    colorId: host.iconColor,
    colorHex: resolveColorHex(host.iconColor),
  };
};

export const resolveHostIconAppearance = (
  host: Partial<Pick<Host, "iconMode" | "iconId" | "iconColor">>,
): HostIconAppearance | null => {
  if (host.iconMode !== "custom") return null;
  if (!isHostIconId(host.iconId) || !isHostIconColorId(host.iconColor)) return null;
  return {
    iconId: host.iconId,
    colorId: host.iconColor,
    colorHex: resolveColorHex(host.iconColor),
  };
};

export const normalizeHostIconSelection = <T extends Partial<Pick<Host, "iconMode" | "iconId" | "iconColor">>>(
  host: T,
): Pick<Host, "iconMode" | "iconId" | "iconColor"> => {
  if (host.iconMode !== "custom") {
    const iconColor = isHostIconColorId(host.iconColor) ? host.iconColor : undefined;
    return iconColor ? { iconMode: "auto", iconColor } : {};
  }
  const iconId = isHostIconId(host.iconId) ? host.iconId : DEFAULT_HOST_ICON_ID;
  const iconColor = isHostIconColorId(host.iconColor) ? host.iconColor : DEFAULT_HOST_ICON_COLOR;
  return { iconMode: "custom", iconId, iconColor };
};

export const sanitizeHostIconFields = <T extends Partial<Pick<Host, "iconMode" | "iconId" | "iconColor">>>(
  host: T,
): Pick<Host, "iconMode" | "iconId" | "iconColor"> => {
  if (host.iconMode !== "custom") {
    return isHostIconColorId(host.iconColor) ? { iconMode: "auto", iconColor: host.iconColor } : {};
  }
  if (!isHostIconId(host.iconId) || !isHostIconColorId(host.iconColor)) return {};
  return { iconMode: "custom", iconId: host.iconId, iconColor: host.iconColor };
};

export const clearHostIconAppearance = <T extends Record<string, unknown>>(
  host: T,
): Omit<T, "iconMode" | "iconId" | "iconColor"> => {
  const { iconMode: _iconMode, iconId: _iconId, iconColor: _iconColor, ...rest } = host;
  return rest;
};
