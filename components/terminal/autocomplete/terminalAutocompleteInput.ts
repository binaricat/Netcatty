import type { MutableRefObject, RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { GhostTextAddon } from "./GhostTextAddon";
import type { AutocompleteSettings } from "./useTerminalAutocomplete";
import { getAlignedPrompt } from "./promptDetector";
import { recordCommand } from "./commandHistoryStore";
import { getCommandToRecordOnEnter } from "./terminalAutocompletePrompt";

interface TerminalAutocompleteInputContext {
  settingsRef: MutableRefObject<AutocompleteSettings>;
  lastKeystrokeRef: MutableRefObject<number>;
  suppressNextEnterRecordRef: MutableRefObject<boolean>;
  lastAcceptedCommandRef: MutableRefObject<string | null>;
  typedInputBufferRef: MutableRefObject<string>;
  typedBufferReliableRef: MutableRefObject<boolean>;
  previewActiveRef: MutableRefObject<boolean>;
  termRef: RefObject<XTerm | null>;
  hostIdRef: MutableRefObject<string>;
  hostOsRef: MutableRefObject<"linux" | "windows" | "macos">;
  ghostAddonRef: MutableRefObject<GhostTextAddon | null>;
  debounceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  clearState: () => void;
  fetchSuggestions: () => void | Promise<void>;
}

export function handleTerminalAutocompleteInput(
  data: string,
  context: TerminalAutocompleteInputContext,
): void {
  const {
    settingsRef,
    lastKeystrokeRef,
    suppressNextEnterRecordRef,
    lastAcceptedCommandRef,
    typedInputBufferRef,
    typedBufferReliableRef,
    previewActiveRef,
    termRef,
    hostIdRef,
    hostOsRef,
    ghostAddonRef,
    debounceTimerRef,
    clearState,
    fetchSuggestions,
  } = context;
  if (!settingsRef.current.enabled) return;

  const now = Date.now();
  const timeSinceLastKeystroke = now - lastKeystrokeRef.current;
  lastKeystrokeRef.current = now;

  // Command recording: Enter key
  if (data === "\r" || data === "\n") {
    // Skip recording if selectAndExecute already recorded this command
    if (suppressNextEnterRecordRef.current) {
      suppressNextEnterRecordRef.current = false;
    } else {
      // If user accepted a completion (Tab/→) and immediately pressed Enter,
      // the buffer may not reflect the accepted text yet. Use the tracked value.
      if (lastAcceptedCommandRef.current) {
        recordCommand(lastAcceptedCommandRef.current, hostIdRef.current, hostOsRef.current);
      } else {
        // Require a live prompt before trusting either keystroke buffer
        // or buffer-based detection — otherwise sudo password Enter
        // would record the typed password as a command.
        const typedBuffer = typedInputBufferRef.current;
        const typedBufferReliable = typedBufferReliableRef.current;
        const { prompt: livePrompt, alignedTyped } = getAlignedPrompt(
          termRef.current,
          typedBuffer,
          typedBufferReliable,
        );
        const commandToRecord = getCommandToRecordOnEnter(
          livePrompt,
          alignedTyped,
          typedBuffer,
          typedBufferReliable,
        );
        if (commandToRecord) {
          recordCommand(commandToRecord, hostIdRef.current, hostOsRef.current);
        }
      }
      lastAcceptedCommandRef.current = null;
    }
    typedInputBufferRef.current = "";
    typedBufferReliableRef.current = true;
    clearState();
    return;
  }

  // Ctrl+C, Ctrl+U — clear. These kill the zle line entirely, so the
  // buffer is once again a true reflection of the (empty) line.
  if (data === "\x03" || data === "\x15") {
    typedInputBufferRef.current = "";
    typedBufferReliableRef.current = true;
    // Same rationale as the ctrl/escape early returns below: any
    // previously-accepted suggestion is gone from the line too, so
    // accept → Ctrl-C → type "foo" → Enter must not log the stale
    // accepted command via the Enter fast path.
    lastAcceptedCommandRef.current = null;
    clearState();
    return;
  }

  // Backspace / DEL: drop the last typed char so the buffer stays aligned
  // with what the shell actually holds.
  if (data === "\x7f" || data === "\b") {
    typedInputBufferRef.current = typedInputBufferRef.current.slice(0, -1);
  } else if (data === "\x17") {
    // Ctrl+W: word-erase — kill the trailing whitespace + word.
    typedInputBufferRef.current = typedInputBufferRef.current.replace(/\s*\S+\s*$/, "");
  } else if (data.startsWith("\x1b[200~")) {
    // Bracketed paste: "\x1b[200~...\x1b[201~". The inner bytes are
    // literal input, so newlines stay on the zle line instead of
    // executing each segment — meaning we must preserve the whole
    // content in the buffer, not just the post-final-newline tail
    // (Codex #814 P2).
    //
    // Reliability is *inherited*, not reset: if the buffer was
    // already aligned with the line (reliable=true), appending this
    // paste keeps it aligned; if the buffer was unreliable (e.g.
    // after ↑ recalled a history command so line ≠ buffer), the
    // paste only extends the tail but the head is still whatever
    // the shell had, so the buffer stays unreliable. Without this,
    // a paste-after-recall flow would flip reliability back on and
    // Enter would record just the pasted suffix as the command
    // (Codex #814 P1 follow-up).
    const endIdx = data.indexOf("\x1b[201~");
    const content = endIdx >= 0
      ? data.slice("\x1b[200~".length, endIdx)
      : data.slice("\x1b[200~".length);
    typedInputBufferRef.current += content;
    // Paste extends the line past whatever was accepted, so the
    // Enter fast-path must not record the pre-paste accepted
    // command — mirrors the non-bracketed paste branch below.
    lastAcceptedCommandRef.current = null;
    clearState();
    return;
  } else if (data.startsWith("\x1b") && data !== "\x1b") {
    // Cursor-movement / function keys — we lose track of where the
    // cursor sits relative to our append-only buffer. Mark the
    // buffer unreliable and drop it; detectPrompt takes over until
    // the next Enter / Ctrl-C / Ctrl-U.
    typedInputBufferRef.current = "";
    typedBufferReliableRef.current = false;
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    typedInputBufferRef.current += data;
  } else if (data.length > 1 && !data.startsWith("\x1b")) {
    // Paste chunk. Any \r / \n inside executes the preceding text as
    // a command in the shell, so keeping the pre-newline portion in
    // our buffer would leave stale content that a later Enter could
    // record (Codex #814 P2). Drop everything up to and including
    // the last terminator and keep only the tail as new content.
    // Intermediate executed lines aren't synthesized back into
    // recordCommand here — the onCommandExecuted path in
    // createXTermRuntime still captures them independently.
    const lastCR = data.lastIndexOf("\r");
    const lastLF = data.lastIndexOf("\n");
    const nlIdx = Math.max(lastCR, lastLF);
    if (nlIdx >= 0) {
      typedInputBufferRef.current = data.slice(nlIdx + 1);
      typedBufferReliableRef.current = true;
      // The embedded newline flushed any previously-accepted
      // suggestion too — clearing the cache here prevents the next
      // Enter from falling into the lastAcceptedCommandRef fast path
      // and recording that stale command.
      lastAcceptedCommandRef.current = null;
      clearState();
      return;
    }
    typedInputBufferRef.current += data;
  } else if (data.length === 1 && data.charCodeAt(0) < 32) {
    // Any other single control char (Ctrl-A, Ctrl-E, Ctrl-B, Ctrl-F,
    // Ctrl-R, Ctrl-P, Ctrl-N, ...) moves the cursor or swaps the
    // line in ways this append-only buffer can't follow. Same story
    // as escape sequences above — and hide the ghost too, so the
    // unreliable-accept fallback doesn't pull a stale tail onto a
    // recalled line (Codex #815 follow-up).
    typedInputBufferRef.current = "";
    typedBufferReliableRef.current = false;
    // Null the fast-path accepted-command cache: accept-then-Ctrl-R
    // should not let an old accepted command sneak back in via the
    // Enter fast path after reverse-search picks a different one.
    lastAcceptedCommandRef.current = null;
    clearState();
    return;
  }

  // Escape sequences (arrow keys, Home, End, etc.): clear stale suggestions
  // since cursor position may have changed, making current suggestions invalid.
  // Up/Down/Right/Tab are handled by handleKeyEvent; other sequences land here.
  if (data.startsWith("\x1b") && data !== "\x1b") {
    // Same fast-path reset as the single-byte ctrl-char branch above —
    // accept-then-↑/↓ must not record the stale accepted command if
    // the user then presses Enter on a different recalled line.
    lastAcceptedCommandRef.current = null;
    clearState();
    return;
  }

  // User is typing more — invalidate accepted command fallback since the
  // command is being edited further (e.g., accepted "git status" then added " --short")
  lastAcceptedCommandRef.current = null;
  // The previewed candidate is now edited, so the line is the user's own
  // text. Drop preview-active so Escape dismisses the popup without
  // reverting these edits back to the stale baseline (#1005).
  previewActiveRef.current = false;

  // Re-align any visible ghost text to the freshly-updated buffer
  // immediately. Without this the ghost keeps the tail it captured at
  // show() time; a fast "type + press →" sequence then pastes the
  // pre-update tail on top of the new input ("doc" + "cker ls" →
  // "doccker ls"). Skip when the user has turned showGhostText off
  // mid-session: otherwise a ghost that was active before the toggle
  // would keep moving around under a setting the user just said to
  // disable (Codex #815 P2).
  //
  // Reliable buffer: feed adjustToInput the full post-mutation buffer
  // so multi-char pastes refresh the ghost as one batch. Unreliable
  // buffer (post Tab / cursor-move / history recall): the buffer
  // is just the suffix typed since unreliability began, so feeding
  // it to adjustToInput would fail the prefix invariant and hide
  // the ghost. Instead let the addon evolve its own currentInput
  // off the keystroke directly (issue #906) — that input was seeded
  // by the last show() with the live xterm reading, which is the
  // only post-Tab source-of-truth we have.
  if (settingsRef.current.showGhostText) {
    if (typedBufferReliableRef.current) {
      ghostAddonRef.current?.adjustToInput(typedInputBufferRef.current);
    } else {
      ghostAddonRef.current?.applyKeystroke(data);
    }
  }

  // Fast typing suppression: if typing faster than threshold, skip this debounce cycle
  const isFastTyping = timeSinceLastKeystroke < settingsRef.current.fastTypingThresholdMs;

  // Debounced suggestion fetch
  if (debounceTimerRef.current) {
    clearTimeout(debounceTimerRef.current);
  }

  if (isFastTyping) {
    // Still debounce, but with a longer delay to wait for typing to pause
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      fetchSuggestions();
    }, settingsRef.current.debounceMs * 3);
  } else {
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      fetchSuggestions();
    }, settingsRef.current.debounceMs);
  }
}
