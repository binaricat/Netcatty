import type { Terminal as XTerm } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

import {
  capHibernateBuffer,
  capHibernateBufferByLines,
  TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES,
  type TerminalHibernateWakePayload,
} from "../../domain/terminalHibernate";
import type { XTermRuntime } from "./runtime/createXTermRuntime";

export function isTerminalAlternateScreenActive(term: XTerm): boolean {
  return (term.buffer.active as { type?: string }).type === "alternate";
}

export function resolveHibernateSerializeOptions(term: XTerm): {
  excludeAltBuffer: boolean;
  excludeModes: boolean;
  alternateScreen: boolean;
} {
  const alternateScreen = isTerminalAlternateScreenActive(term);
  return {
    excludeAltBuffer: !alternateScreen,
    excludeModes: !alternateScreen,
    alternateScreen,
  };
}

export function serializeTerminalForHibernate(term: XTerm, serializeAddon: SerializeAddon): {
  snapshot: string;
  alternateScreen: boolean;
} {
  try {
    const { excludeAltBuffer, excludeModes, alternateScreen } = resolveHibernateSerializeOptions(term);
    const raw = serializeAddon.serialize({
      excludeAltBuffer,
      excludeModes,
    });
    return {
      snapshot: capHibernateBufferByLines(raw, TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES),
      alternateScreen,
    };
  } catch {
    return {
      snapshot: "",
      alternateScreen: isTerminalAlternateScreenActive(term),
    };
  }
}

export function appendHibernatePendingBuffer(current: string, chunk: string): string {
  return capHibernateBuffer(current + chunk);
}

const writeTerminalPayload = (term: XTerm, data: string): Promise<void> => {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => {
    term.write(data, () => resolve());
  });
};

export function refreshTerminalViewport(term: XTerm): void {
  const endRow = term.rows - 1;
  if (endRow < 0) return;
  term.refresh(0, endRow);
}

export async function appendTerminalReplayData(term: XTerm, data: string): Promise<void> {
  return writeTerminalPayload(term, data);
}

export async function applyHibernateWakeToTerminal(
  term: XTerm,
  runtime: XTermRuntime,
  payload: TerminalHibernateWakePayload,
): Promise<void> {
  await writeTerminalPayload(term, payload.snapshot);
  await writeTerminalPayload(term, payload.pendingBuffer);
  runtime.ensureWebglRenderer();
  runtime.clearTextureAtlas();
  if (payload.alternateScreen) {
    refreshTerminalViewport(term);
  }
}

export function nudgeAlternateScreenRedraw(term: XTerm): void {
  refreshTerminalViewport(term);
  const cols = term.cols;
  const rows = term.rows;
  if (cols > 0 && rows > 0) {
    // Many full-screen TUIs (htop, vim) repaint on a size "change" even when dimensions match.
    term.resize(cols, rows);
    refreshTerminalViewport(term);
  }
}
