import type { Host, HostIconColorId, HostIconColorMode, HostIconId, HostIconMode } from "./models";

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

export const HOST_ICON_DEFAULT_COLORS = {
  "server": "blue",
  "terminal": "slate",
  "database": "cyan",
  "cloud": "sky",
  "router": "orange",
  "shield": "green",
  "code": "violet",
  "box": "amber",
  "globe": "teal",
  "cpu": "indigo",
  "hard-drive": "zinc",
  "network": "lime",
  "wifi": "purple",
  "lock": "rose",
  "key": "amber",
  "monitor": "sky",
  "container": "teal",
  "activity": "red",
  "zap": "orange",
  "server-cog": "slate",
} as const satisfies Record<HostIconId, HostIconColorId>;

export type HostIconAppearance = {
  iconId: HostIconId;
  colorId?: HostIconColorId;
  colorHex: string;
};

export type HostIconColorAppearance = {
  colorId?: HostIconColorId;
  colorHex: string;
};

export const isHostIconMode = (value: unknown): value is HostIconMode =>
  value === "auto" || value === "custom";

export const isHostIconId = (value: unknown): value is HostIconId =>
  typeof value === "string" && (HOST_ICON_IDS as readonly string[]).includes(value);

export const isHostIconColorId = (value: unknown): value is HostIconColorId =>
  typeof value === "string" && HOST_ICON_COLORS.some((color) => color.id === value);

export const isHostIconColorMode = (value: unknown): value is HostIconColorMode =>
  value === "auto" || value === "manual";

export const isHostIconCustomColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

const resolveColorHex = (colorId: HostIconColorId): string =>
  HOST_ICON_COLORS.find((color) => color.id === colorId)?.hex || HOST_ICON_COLORS[0].hex;

export const resolveHostIconDefaultColorHex = (iconId: HostIconId): string =>
  resolveColorHex(HOST_ICON_DEFAULT_COLORS[iconId] || DEFAULT_HOST_ICON_COLOR);

export const resolveHostIconColorAppearance = (
  host: Partial<Pick<Host, "iconColorMode" | "iconColor" | "iconColorCustom">>,
): HostIconColorAppearance | null => {
  const manualColor = host.iconColorMode === "manual" ||
    (host.iconColorMode !== "auto" && (isHostIconColorId(host.iconColor) || isHostIconCustomColor(host.iconColorCustom)));
  if (!manualColor) return null;
  if (isHostIconCustomColor(host.iconColorCustom)) {
    return {
      colorHex: host.iconColorCustom,
    };
  }
  return {
    colorId: isHostIconColorId(host.iconColor) ? host.iconColor : DEFAULT_HOST_ICON_COLOR,
    colorHex: resolveColorHex(isHostIconColorId(host.iconColor) ? host.iconColor : DEFAULT_HOST_ICON_COLOR),
  };
};

export const resolveHostIconAppearance = (
  host: Partial<Pick<Host, "iconMode" | "iconId" | "iconColorMode" | "iconColor" | "iconColorCustom">>,
): HostIconAppearance | null => {
  if (host.iconMode !== "custom") return null;
  if (!isHostIconId(host.iconId)) return null;
  const color = resolveHostIconColorAppearance(host);
  return {
    iconId: host.iconId,
    ...(color?.colorId ? { colorId: color.colorId } : {}),
    colorHex: color?.colorHex || resolveHostIconDefaultColorHex(host.iconId),
  };
};

export const normalizeHostIconSelection = <T extends Partial<Pick<Host, "iconMode" | "iconId" | "iconColorMode" | "iconColor" | "iconColorCustom">>>(
  host: T,
): Pick<Host, "iconMode" | "iconId" | "iconColorMode" | "iconColor" | "iconColorCustom"> => {
  const iconColorMode = host.iconColorMode === "manual" ||
    (host.iconColorMode !== "auto" && (isHostIconColorId(host.iconColor) || isHostIconCustomColor(host.iconColorCustom)))
    ? "manual"
    : undefined;
  const iconColor = iconColorMode === "manual" && isHostIconColorId(host.iconColor) ? host.iconColor : undefined;
  const iconColorCustom = iconColorMode === "manual" && isHostIconCustomColor(host.iconColorCustom) ? host.iconColorCustom : undefined;
  const colorFields = {
    ...(iconColorMode ? { iconColorMode } : {}),
    ...(iconColor ? { iconColor } : {}),
    ...(iconColorCustom ? { iconColorCustom } : {}),
  };
  if (host.iconMode !== "custom") {
    return iconColorMode ? { iconMode: "auto", ...colorFields } : {};
  }
  const iconId = isHostIconId(host.iconId) ? host.iconId : DEFAULT_HOST_ICON_ID;
  return { iconMode: "custom", iconId, ...colorFields };
};

export const sanitizeHostIconFields = <T extends Partial<Pick<Host, "iconMode" | "iconId" | "iconColorMode" | "iconColor" | "iconColorCustom">>>(
  host: T,
): Pick<Host, "iconMode" | "iconId" | "iconColorMode" | "iconColor" | "iconColorCustom"> => {
  const iconColorMode = host.iconColorMode === "manual" ||
    (host.iconColorMode !== "auto" && (isHostIconColorId(host.iconColor) || isHostIconCustomColor(host.iconColorCustom)))
    ? "manual"
    : undefined;
  const iconColor = iconColorMode === "manual" && isHostIconColorId(host.iconColor) ? host.iconColor : undefined;
  const iconColorCustom = iconColorMode === "manual" && isHostIconCustomColor(host.iconColorCustom) ? host.iconColorCustom : undefined;
  const colorFields = {
    ...(iconColorMode ? { iconColorMode } : {}),
    ...(iconColor ? { iconColor } : {}),
    ...(iconColorCustom ? { iconColorCustom } : {}),
  };
  if (host.iconMode !== "custom") {
    return iconColorMode ? { iconMode: "auto", ...colorFields } : {};
  }
  if (!isHostIconId(host.iconId)) return {};
  return { iconMode: "custom", iconId: host.iconId, ...colorFields };
};

export const clearHostIconAppearance = <T extends Record<string, unknown>>(
  host: T,
): Omit<T, "iconMode" | "iconId" | "iconColorMode" | "iconColor" | "iconColorCustom"> => {
  const {
    iconMode: _iconMode,
    iconId: _iconId,
    iconColorMode: _iconColorMode,
    iconColor: _iconColor,
    iconColorCustom: _iconColorCustom,
    ...rest
  } = host;
  return rest;
};
