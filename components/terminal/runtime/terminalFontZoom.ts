import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "../../../infrastructure/config/fonts";

type WheelLike = Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaY">;

const TERMINAL_FONT_SIZE_ACTIONS = new Set([
  "increaseTerminalFontSize",
  "decreaseTerminalFontSize",
  "resetTerminalFontSize",
]);

export const terminalFontSizeWheelListenerOptions = {
  passive: false,
  capture: true,
} as const satisfies AddEventListenerOptions;

export const clampTerminalFontSize = (fontSize: number): number =>
  Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize));

export const isTerminalFontSizeAction = (action: string): boolean =>
  TERMINAL_FONT_SIZE_ACTIONS.has(action);

export const shouldHandleTerminalFontSizeAction = (
  action: string,
  disabled = false,
): boolean => isTerminalFontSizeAction(action) && !disabled;

export const nextTerminalFontSizeForAction = (
  action: string,
  currentFontSize: number,
  disabled = false,
): number | null => {
  if (disabled) return null;
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
  disabled = false,
): number | null => {
  if (disabled) return null;
  const hasZoomModifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!hasZoomModifier || event.deltaY === 0) return null;
  return clampTerminalFontSize(currentFontSize + (event.deltaY < 0 ? 1 : -1));
};
