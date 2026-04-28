import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";

import type { TerminalSettings } from "../../../types";

type CursorPreferenceSettings = Pick<TerminalSettings, "cursorShape" | "cursorBlink">;

type MutableCursorOptions = {
  cursorStyle?: "block" | "bar" | "underline";
  cursorBlink?: boolean;
};

type TerminalLike = {
  options: MutableCursorOptions;
  parser?: {
    registerCsiHandler?: (
      id: { prefix?: string; intermediates?: string; final: string },
      callback: (params: readonly (number | number[])[]) => boolean,
    ) => IDisposable;
  };
  _core?: {
    coreService?: {
      decPrivateModes?: {
        cursorStyle?: "block" | "bar" | "underline";
        cursorBlink?: boolean;
      };
    };
  };
};

const scheduleAfterDefaultHandler = (callback: () => void): void => {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }

  setTimeout(callback, 0);
};

const hasCursorBlinkPrivateModeParam = (params: readonly (number | number[])[]): boolean => (
  params.some((param) => (
    Array.isArray(param)
      ? param.includes(12)
      : param === 12
  ))
);

export const resolveUserCursorPreference = (
  settings: Partial<CursorPreferenceSettings> | undefined,
): Required<CursorPreferenceSettings> => ({
  cursorShape: settings?.cursorShape ?? "block",
  cursorBlink: settings?.cursorBlink ?? true,
});

export const applyUserCursorPreference = (
  term: TerminalLike,
  settings: Partial<CursorPreferenceSettings> | undefined,
): void => {
  const preference = resolveUserCursorPreference(settings);
  const privateModes = term._core?.coreService?.decPrivateModes;
  if (privateModes) {
    privateModes.cursorStyle = undefined;
    privateModes.cursorBlink = undefined;
  }
  term.options.cursorStyle = preference.cursorShape;
  term.options.cursorBlink = preference.cursorBlink;
};

export const applyUserCursorBlinkPreference = (
  term: TerminalLike,
  settings: Partial<CursorPreferenceSettings> | undefined,
): void => {
  const preference = resolveUserCursorPreference(settings);
  const privateModes = term._core?.coreService?.decPrivateModes;
  if (privateModes) {
    privateModes.cursorBlink = undefined;
  }
  term.options.cursorBlink = preference.cursorBlink;
};

export const installUserCursorPreferenceGuard = (
  term: XTerm | TerminalLike,
  terminalSettingsRef: RefObject<TerminalSettings | undefined>,
): IDisposable | null => {
  const terminal = term as TerminalLike;
  const parser = terminal.parser;
  if (!parser?.registerCsiHandler) return null;
  const registerCsiHandler = parser.registerCsiHandler.bind(parser);

  const applyBlinkPreference = () => applyUserCursorBlinkPreference(terminal, terminalSettingsRef.current);

  const cursorStyleDisposable = registerCsiHandler({ intermediates: " ", final: "q" }, () => {
    scheduleAfterDefaultHandler(applyBlinkPreference);
    return false;
  });

  const cursorBlinkSetDisposable = registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (hasCursorBlinkPrivateModeParam(params)) {
      scheduleAfterDefaultHandler(applyBlinkPreference);
    }
    return false;
  });

  const cursorBlinkResetDisposable = registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (hasCursorBlinkPrivateModeParam(params)) {
      scheduleAfterDefaultHandler(applyBlinkPreference);
    }
    return false;
  });

  return {
    dispose: () => {
      cursorStyleDisposable.dispose();
      cursorBlinkSetDisposable.dispose();
      cursorBlinkResetDisposable.dispose();
    },
  };
};
