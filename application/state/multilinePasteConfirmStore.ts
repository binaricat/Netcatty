/**
 * App-level store for the "paste multiple lines" confirmation dialog (#3398).
 *
 * Terminal paste handlers call `requestMultilinePasteConfirm` from anywhere in
 * the renderer and await the user's decision; `MultilinePasteConfirmHost`
 * (mounted once in App) renders the dialog and resolves the pending request.
 */

export type MultilinePasteConfirmAction = "send" | "line-by-line" | "cancel";

export interface MultilinePasteConfirmRequest {
  id: string;
  /** Clipboard text the dialog previews (editable by the user). */
  text: string;
  lineCount: number;
  charCount: number;
  /** Restore the originating terminal's focus after the modal releases it. */
  onClose?: () => void;
}

export interface MultilinePasteConfirmResponse {
  action: MultilinePasteConfirmAction;
  /** Text to send: the preview content, possibly edited by the user. */
  text: string;
}

interface PendingRequest {
  request: MultilinePasteConfirmRequest;
  resolve: (response: MultilinePasteConfirmResponse) => void;
}

let pending: PendingRequest | null = null;
let nextRequestId = 0;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export function requestMultilinePasteConfirm(
  request: Omit<MultilinePasteConfirmRequest, "id">,
): Promise<MultilinePasteConfirmResponse> {
  // Only one confirmation dialog can be pending; a newer paste supersedes the
  // older one (the stale promise resolves as "cancel" so its paste is dropped).
  if (pending) {
    const stale = pending;
    pending = null;
    stale.resolve({ action: "cancel", text: stale.request.text });
  }
  nextRequestId += 1;
  const requestWithId: MultilinePasteConfirmRequest = {
    ...request,
    id: `multiline-paste-${nextRequestId}`,
  };
  return new Promise((resolve) => {
    pending = { request: requestWithId, resolve };
    emit();
  });
}

export function respondMultilinePasteConfirm(
  action: MultilinePasteConfirmAction,
  text?: string,
): void {
  const current = pending;
  if (!current) return;
  pending = null;
  current.resolve({ action, text: text ?? current.request.text });
  emit();
}

/** Snapshot for `useSyncExternalStore`; stable reference while pending. */
export const getPendingMultilinePasteConfirm =
  (): MultilinePasteConfirmRequest | null => pending?.request ?? null;

export function subscribeMultilinePasteConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
