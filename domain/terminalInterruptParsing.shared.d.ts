interface TerminalInterruptMeasureOptions {
  measureLength?: (value: string) => number;
}

interface TerminalInterruptExtractOptions extends TerminalInterruptMeasureOptions {
  holdTrailingPartial?: boolean;
}

declare module "./terminalInterruptParsing.shared.cjs" {
  export function stripAnsi(value: string): string;
  export function getTrailingDisplayControlPrefix(text: string): string;
  export function extractTerminalStateRestoreControls(
    text: string,
    options?: TerminalInterruptExtractOptions,
  ): { preserved: string; pending: string; droppedBytes: number };
  export function finalizeAcceptedTextAfterPendingDisplayControl(
    pending: string,
    text: string,
    options?: TerminalInterruptMeasureOptions,
  ): { data: string; droppedBytes: number };
  export function isCompletePasswordPrompt(candidate: string): boolean;
  export function isProbablePasswordPromptPrefix(candidate: string): boolean;
  export function hasTrailingPasswordKeywordPrefix(trimmed: string): boolean;
  export function getTrailingPasswordPromptPrefix(text: string): string;
  export function stripLeadingPreservedOverlap(passwordPending: string, preserved: string): string;
  export function consumeTrailingCsiCompletion(
    pending: string,
    text: string,
  ): { text: string; extraDroppedBytes: number };
  export function isStandaloneHoldableControlPrefix(pending: string): boolean;
  export function extractDrainHold(
    text: string,
    options?: TerminalInterruptExtractOptions,
  ): { preserved: string; pending: string; droppedBytes: number };
  export function isPasswordPrefixPending(pending: string): boolean;
  export function getLastVisibleLine(text: string): string;
  export function resolveHeldPasswordPrefix(
    pending: string,
    text: string,
    options?: TerminalInterruptMeasureOptions,
  ): { pending: string; text: string; droppedPendingBytes: number };
  export function getPromptCandidateSuffix(text: string): string | null;
}

declare module "@/domain/terminalInterruptParsing.shared.cjs" {
  export function stripAnsi(value: string): string;
  export function getTrailingDisplayControlPrefix(text: string): string;
  export function extractTerminalStateRestoreControls(
    text: string,
    options?: TerminalInterruptExtractOptions,
  ): { preserved: string; pending: string; droppedBytes: number };
  export function finalizeAcceptedTextAfterPendingDisplayControl(
    pending: string,
    text: string,
    options?: TerminalInterruptMeasureOptions,
  ): { data: string; droppedBytes: number };
  export function isCompletePasswordPrompt(candidate: string): boolean;
  export function isProbablePasswordPromptPrefix(candidate: string): boolean;
  export function hasTrailingPasswordKeywordPrefix(trimmed: string): boolean;
  export function getTrailingPasswordPromptPrefix(text: string): string;
  export function stripLeadingPreservedOverlap(passwordPending: string, preserved: string): string;
  export function consumeTrailingCsiCompletion(
    pending: string,
    text: string,
  ): { text: string; extraDroppedBytes: number };
  export function isStandaloneHoldableControlPrefix(pending: string): boolean;
  export function extractDrainHold(
    text: string,
    options?: TerminalInterruptExtractOptions,
  ): { preserved: string; pending: string; droppedBytes: number };
  export function isPasswordPrefixPending(pending: string): boolean;
  export function getLastVisibleLine(text: string): string;
  export function resolveHeldPasswordPrefix(
    pending: string,
    text: string,
    options?: TerminalInterruptMeasureOptions,
  ): { pending: string; text: string; droppedPendingBytes: number };
  export function getPromptCandidateSuffix(text: string): string | null;
}
