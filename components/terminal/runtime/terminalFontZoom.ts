import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "../../../infrastructure/config/fonts";

type WheelLike = Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaY">;

export const clampTerminalFontSize = (fontSize: number): number =>
  Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize));

export const nextTerminalFontSizeForAction = (
  action: string,
  currentFontSize: number,
): number | null => {
  switch (action) {
    case "increaseTerminalFontSize":
      return clampTerminalFontSize(currentFontSize + 1);
    case "decreaseTerminalFontSize":
      return clampTerminalFontSize(currentFontSize - 1);
    case "resetTerminalFontSize":
      return DEFAULT_FONT_SIZE;
    default:
      return null;
  }
};

export const nextTerminalFontSizeForWheel = (
  event: WheelLike,
  currentFontSize: number,
  isMac: boolean,
): number | null => {
  const hasZoomModifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!hasZoomModifier || event.deltaY === 0) return null;
  return clampTerminalFontSize(currentFontSize + (event.deltaY < 0 ? 1 : -1));
};
