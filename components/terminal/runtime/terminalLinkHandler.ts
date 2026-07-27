export type TerminalLinkClickEvent = Pick<
  MouseEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export type TerminalLinkHandlerOptions = {
  canActivate: (event: TerminalLinkClickEvent) => boolean;
  openExternalAvailable: () => boolean;
  openExternal: (uri: string) => Promise<void>;
  confirmOscLink: (uri: string) => boolean;
  openWindow?: (uri: string) => unknown;
  onError?: (error: unknown) => void;
  warn?: (...args: unknown[]) => void;
};

export type TerminalLinkHandler = {
  activate: (event: TerminalLinkClickEvent, uri: string) => void;
  activateOsc: (event: TerminalLinkClickEvent, uri: string) => void;
  open: (uri: string) => Promise<void>;
};

export function createTerminalLinkHandler(
  options: TerminalLinkHandlerOptions,
): TerminalLinkHandler {
  const warn = options.warn ?? console.warn;

  const open = async (uri: string): Promise<void> => {
    if (!/^https?:\/\//iu.test(String(uri || ""))) {
      warn("[XTerm] Refusing to open non-http(s) link:", uri);
      return;
    }

    try {
      if (options.openExternalAvailable()) {
        await options.openExternal(uri);
        return;
      }

      (options.openWindow ?? ((url) => window.open(
        url,
        "_blank",
        "noopener,noreferrer",
      )))(uri);
    } catch (error) {
      warn("[XTerm] Failed to open terminal link:", error);
      options.onError?.(error);
    }
  };

  return {
    activate(event, uri) {
      if (!options.canActivate(event)) return;
      void open(uri);
    },
    activateOsc(event, uri) {
      if (!options.canActivate(event)) return;
      if (!/^https?:\/\//iu.test(String(uri || ""))) {
        warn("[XTerm] Refusing to open non-http(s) link:", uri);
        return;
      }
      if (!options.confirmOscLink(uri)) return;
      void open(uri);
    },
    open,
  };
}
