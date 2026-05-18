import type { RefObject } from "react";
import type { Host } from "../../../types";
import {
  markPromptLineBreakCommandPending,
  type PromptLineBreakState,
} from "./promptLineBreak";

type TerminalCommandExecutionContext = {
  host: Pick<Host, "id" | "label">;
  sessionId: string;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  commandBufferRef: RefObject<string>;
  promptLineBreakStateRef?: RefObject<PromptLineBreakState>;
};

export const recordTerminalCommandExecution = (
  command: string,
  ctx: TerminalCommandExecutionContext,
) => {
  const cmd = command.trim();
  if (cmd) {
    ctx.onCommandExecuted?.(cmd, ctx.host.id, ctx.host.label, ctx.sessionId);
  }
  ctx.commandBufferRef.current = "";
  markPromptLineBreakCommandPending(ctx.promptLineBreakStateRef);
};
