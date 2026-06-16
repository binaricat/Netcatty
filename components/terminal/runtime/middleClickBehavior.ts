import type { MiddleClickBehavior, TerminalSettings } from "../../../domain/models";

type MiddleClickSettings = Partial<Pick<TerminalSettings, "middleClickBehavior" | "middleClickPaste">>;
const MIDDLE_CONTEXT_MENU_EVENT_KEY = "__netcattyMiddleContextMenu";

type MiddleClickContextMenuEvent = MouseEvent & {
  [MIDDLE_CONTEXT_MENU_EVENT_KEY]?: boolean;
};

export interface MouseTrackingContextMenuCaptureState {
  event: MouseEvent;
  mouseTracking: boolean;
  status?: string | null;
}

export const resolveMiddleClickBehavior = (
  settings?: MiddleClickSettings | null,
): MiddleClickBehavior => {
  const behavior = settings?.middleClickBehavior;
  if (
    behavior === "context-menu" ||
    behavior === "paste" ||
    behavior === "disabled"
  ) {
    return behavior;
  }

  return settings?.middleClickPaste === false ? "disabled" : "paste";
};

export const markMiddleClickContextMenuEvent = (event: MouseEvent): MouseEvent => {
  Object.defineProperty(event, MIDDLE_CONTEXT_MENU_EVENT_KEY, {
    value: true,
    configurable: true,
  });
  return event;
};

export const isMiddleClickContextMenuEvent = (event: MouseEvent): boolean =>
  (event as MiddleClickContextMenuEvent)[MIDDLE_CONTEXT_MENU_EVENT_KEY] === true;

export const shouldInterceptMouseTrackingContextMenu = ({
  event,
  mouseTracking,
  status,
}: MouseTrackingContextMenuCaptureState): boolean =>
  mouseTracking && status === "connected" && !isMiddleClickContextMenuEvent(event);

export const captureMiddleClickTerminalMouseEvent = (event: MouseEvent): boolean => {
  if (event.button !== 1) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
};
