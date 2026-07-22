import type { IDisposable } from "@xterm/xterm";

import {
  buildKittyKeyboardModeQueryResponse,
  popKittyKeyboardModeFlags,
  pushKittyKeyboardModeFlags,
  setKittyKeyboardAlternateScreenActive,
  setKittyKeyboardModeFlags,
  resetKittyKeyboardModeState,
  type KittyKeyboardModeApplyMode,
  type KittyKeyboardModeState,
} from "./kittyKeyboardProtocol";

export type KittyKeyboardCsiParams = readonly (number | number[])[];

type CsiHandlerId = {
  prefix?: string;
  intermediates?: string;
  final: string;
};

type KittyKeyboardParser = {
  registerCsiHandler: (
    id: CsiHandlerId,
    callback: (params: KittyKeyboardCsiParams) => boolean,
  ) => IDisposable;
  registerEscHandler: (
    id: { intermediates?: string; final: string },
    callback: () => boolean,
  ) => IDisposable;
};

export const readKittyKeyboardCsiParam = (
  params: KittyKeyboardCsiParams,
  index: number,
  fallback: number,
): number => {
  const value = params[index];
  if (Array.isArray(value)) return typeof value[0] === "number" ? value[0] : fallback;
  return typeof value === "number" && value > 0 ? value : fallback;
};

const normalizeKittyKeyboardApplyMode = (mode: number): KittyKeyboardModeApplyMode => {
  return mode === 2 || mode === 3 ? mode : 1;
};

const paramsIncludeAny = (
  params: KittyKeyboardCsiParams,
  targets: readonly number[],
): boolean => {
  return params.some((param) => (
    Array.isArray(param)
      ? param.some((value) => targets.includes(value))
      : targets.includes(param)
  ));
};

export const installKittyKeyboardProtocolHandlers = (
  parser: KittyKeyboardParser,
  state: KittyKeyboardModeState,
  writeReply: (payload: string) => void,
): IDisposable => {
  const disposables = [
    parser.registerCsiHandler(
      { prefix: "?", final: "u" },
      () => {
        writeReply(buildKittyKeyboardModeQueryResponse(state));
        return true;
      },
    ),
    parser.registerEscHandler(
      { final: "c" },
      () => {
        resetKittyKeyboardModeState(state);
        return false;
      },
    ),
    parser.registerCsiHandler(
      { prefix: "=", final: "u" },
      (params) => {
        const flags = readKittyKeyboardCsiParam(params, 0, 0);
        const mode = normalizeKittyKeyboardApplyMode(readKittyKeyboardCsiParam(params, 1, 1));
        setKittyKeyboardModeFlags(state, flags, mode);
        return true;
      },
    ),
    parser.registerCsiHandler(
      { prefix: ">", final: "u" },
      (params) => {
        pushKittyKeyboardModeFlags(state, readKittyKeyboardCsiParam(params, 0, 0));
        return true;
      },
    ),
    parser.registerCsiHandler(
      { prefix: "<", final: "u" },
      (params) => {
        popKittyKeyboardModeFlags(state, readKittyKeyboardCsiParam(params, 0, 1));
        return true;
      },
    ),
    parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (paramsIncludeAny(params, [47, 1047, 1049])) {
          setKittyKeyboardAlternateScreenActive(state, true);
        }
        return false;
      },
    ),
    parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        if (paramsIncludeAny(params, [47, 1047, 1049])) {
          setKittyKeyboardAlternateScreenActive(state, false);
        }
        return false;
      },
    ),
  ];

  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
};

export const installKittyKeyboardProtocolHandlersIfEnabled = (
  enabled: boolean | undefined,
  parser: KittyKeyboardParser,
  state: KittyKeyboardModeState,
  writeReply: (payload: string) => void,
): IDisposable | undefined => {
  if (enabled !== true) return undefined;
  return installKittyKeyboardProtocolHandlers(parser, state, writeReply);
};
