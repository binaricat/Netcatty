import type { MiddleClickBehavior, TerminalSettings } from "../../../domain/models";

type MiddleClickSettings = Partial<Pick<TerminalSettings, "middleClickBehavior" | "middleClickPaste">>;
const MIDDLE_CONTEXT_MENU_EVENT_KEY = "__netcattyMiddleContextMenu";

type MiddleClickContextMenuEvent = MouseEvent & {
  [MIDDLE_CONTEXT_MENU_EVENT_KEY]?: boolean;
};

const SHIFT_SELECTION_REPLAY_EVENT_KEY = "__netcattyShiftSelectionReplay";

type ShiftSelectionReplayMouseEvent = MouseEvent & {
  [SHIFT_SELECTION_REPLAY_EVENT_KEY]?: boolean;
};

export interface MouseTrackingContextMenuCaptureState {
  event: MouseEvent;
  mouseTracking: boolean;
  status?: string | null;
}

export interface ShiftMouseSelectionReplayState {
  event: MouseEvent;
  mouseTracking: boolean;
  status?: string | null;
  isMacPlatform: boolean;
}

export interface ShiftRightClickMouseDownCaptureState {
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

export const markShiftSelectionReplayMouseEvent = (event: MouseEvent): MouseEvent => {
  Object.defineProperty(event, SHIFT_SELECTION_REPLAY_EVENT_KEY, {
    value: true,
    configurable: true,
  });
  return event;
};

export const isShiftSelectionReplayMouseEvent = (event: MouseEvent): boolean =>
  (event as ShiftSelectionReplayMouseEvent)[SHIFT_SELECTION_REPLAY_EVENT_KEY] === true;

export const shouldInterceptMouseTrackingContextMenu = ({
  event,
  mouseTracking,
  status,
}: MouseTrackingContextMenuCaptureState): boolean =>
  mouseTracking
  && status === "connected"
  && !event.shiftKey
  && !isMiddleClickContextMenuEvent(event);

export const shouldReplayShiftMouseSelectionAsMacOption = ({
  event,
  mouseTracking,
  status,
  isMacPlatform,
}: ShiftMouseSelectionReplayState): boolean =>
  isMacPlatform
  && mouseTracking
  && status === "connected"
  && event.button === 0
  && event.shiftKey
  && !event.altKey
  && !event.ctrlKey
  && !event.metaKey
  && !isShiftSelectionReplayMouseEvent(event);

export const shouldStopShiftRightClickMouseTrackingMouseDown = ({
  event,
  mouseTracking,
  status,
}: ShiftRightClickMouseDownCaptureState): boolean =>
  mouseTracking
  && status === "connected"
  && event.button === 2
  && event.shiftKey;

export const createMacOptionForcedSelectionMouseEvent = (event: MouseEvent): MouseEvent =>
  markShiftSelectionReplayMouseEvent(new MouseEvent(event.type, {
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    detail: event.detail,
    view: event.view,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    altKey: true,
    shiftKey: false,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
  }));

export const captureMiddleClickTerminalMouseEvent = (event: MouseEvent): boolean => {
  if (event.button !== 1) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
};
