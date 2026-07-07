import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { GhostTextAddon } from "./GhostTextAddon";
import type { AutocompleteSettings, AutocompleteState, SubDirEntry } from "./useTerminalAutocomplete";
import type { Snippet } from "../../../domain/models";

interface TerminalAutocompleteKeyEventContext {
  settingsRef: MutableRefObject<AutocompleteSettings>;
  stateRef: MutableRefObject<AutocompleteState>;
  ghostAddonRef: MutableRefObject<GhostTextAddon | null>;
  typedInputBufferRef: MutableRefObject<string>;
  typedBufferReliableRef: MutableRefObject<boolean>;
  previewActiveRef: MutableRefObject<boolean>;
  lastAcceptedCommandRef: MutableRefObject<string | null>;
  setState: Dispatch<SetStateAction<AutocompleteState>>;
  expandSubDir: (level: number, entry: SubDirEntry, moveFocus?: boolean) => void;
  writeToTerminal: (text: string) => void;
  clearState: () => void;
  renderSubDirPath: (level: number, entry: SubDirEntry) => void;
  handleSubDirSelect: (level: number, entry: SubDirEntry) => void;
  fetchSubDirForIndex: (index: number) => void;
  renderPreviewSelection: (index: number) => void;
  acceptPreviewlessSelection: (index: number) => boolean;
  acceptSnippet: (snippet: Snippet) => boolean;
}

const isAutocompleteConfirmEnter = (
  e: KeyboardEvent,
  settings: AutocompleteSettings,
): boolean => (
  e.key === "Enter" &&
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey &&
  (!e.shiftKey || settings.shiftEnterNewlineEnabled === false)
);

export function handleTerminalAutocompleteKeyEvent(
  e: KeyboardEvent,
  context: TerminalAutocompleteKeyEventContext,
): boolean {
  const {
    settingsRef,
    stateRef,
    ghostAddonRef,
    typedInputBufferRef,
    typedBufferReliableRef,
    previewActiveRef,
    lastAcceptedCommandRef,
    setState,
    expandSubDir,
    writeToTerminal,
    clearState,
    renderSubDirPath,
    handleSubDirSelect,
    fetchSubDirForIndex,
    renderPreviewSelection,
    acceptPreviewlessSelection,
    acceptSnippet,
  } = context;
  if (!settingsRef.current.enabled || e.type !== "keydown") return true;

  const s = stateRef.current;
  const ghost = ghostAddonRef.current;

  // Right arrow: if popup has selected directory with sub-dir panel, enter it
  // Skip this handler entirely when sub-dir panels are focused — let the
  // sub-panel navigation block handle → for deeper expansion.
  if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && s.subDirFocusLevel < 0) {
    if (s.popupVisible && s.selectedIndex >= 0 && s.subDirPanels.length > 0) {
      const selected = s.suggestions[s.selectedIndex];
      if (selected?.fileType === "directory") {
        e.preventDefault();
        const firstEntry = s.subDirPanels[0]?.entries[0];
        setState((prev) => {
          const panels = [...prev.subDirPanels];
          if (panels[0]) panels[0] = { ...panels[0], selectedIndex: 0 };
          return { ...prev, subDirPanels: panels, subDirFocusLevel: 0 };
        });
        if (firstEntry?.type === "directory") {
          expandSubDir(0, firstEntry, false);
        }
        return false;
      }
    }
    // Otherwise: accept ghost text. Use isActive(), not isVisible(),
    // so a fast "type + →" that lands in the hide-until-render gap
    // still hits this branch and accepts the pending ghost.
    if (ghost?.isActive()) {
      e.preventDefault();
      const fullSuggestion = ghost.getSuggestion();
      // When the keystroke buffer is reliable, recompute the tail
      // against the *live* buffer so a fast "type + →" in the
      // hide-until-render gap still writes the correct tail. When
      // it's not reliable (post history-recall / Ctrl-R), we can't
      // treat empty buffer as "nothing typed" — the line actually
      // has content we're not tracking — so fall back to the
      // ghost's own cached tail instead of writing the entire
      // suggestion onto an already-populated line.
      let ghostText: string;
      let newBuffer: string | null;
      if (typedBufferReliableRef.current) {
        const live = typedInputBufferRef.current;
        if (fullSuggestion && fullSuggestion.startsWith(live)) {
          ghostText = fullSuggestion.substring(live.length);
          newBuffer = fullSuggestion;
        } else {
          ghostText = "";
          newBuffer = null;
        }
      } else {
        ghostText = ghost.getGhostText();
        newBuffer = null; // buffer is unreliable; don't flip it back on
      }
      if (ghostText) {
        writeToTerminal(ghostText);
        lastAcceptedCommandRef.current = fullSuggestion;
        if (newBuffer !== null) {
          typedInputBufferRef.current = newBuffer;
          typedBufferReliableRef.current = true;
        }
        ghost.hide();
        clearState();
      } else {
        ghost.hide();
      }
      return false;
    }
  }

  // Ctrl+Right / Alt+Right (Mac): accept next word
  if (e.key === "ArrowRight" && (e.ctrlKey || e.altKey) && !e.metaKey && !e.shiftKey) {
    if (ghost?.isActive()) {
      e.preventDefault();
      const fullSuggestion = ghost.getSuggestion();
      if (!fullSuggestion) {
        ghost.hide();
        return false;
      }
      // Determine the baseline the next word should extend. Reliable
      // buffer: resync the ghost to the live buffer so getNextWord
      // operates on the up-to-date tail. Unreliable buffer (post
      // history-recall / Ctrl-R): don't reanchor to "" — that would
      // make getNextWord hand back the very first word and the shell
      // would duplicate leading tokens on top of the recalled line.
      // Fall back to the ghost's existing cached input instead.
      if (typedBufferReliableRef.current) {
        const live = typedInputBufferRef.current;
        if (fullSuggestion.startsWith(live)) {
          ghost.show(fullSuggestion, live);
        } else {
          ghost.hide();
          return false;
        }
      }
      const base = ghost.getGhostText().length > 0
        ? fullSuggestion.substring(0, fullSuggestion.length - ghost.getGhostText().length)
        : fullSuggestion;
      const nextWord = ghost.getNextWord();
      if (nextWord) {
        writeToTerminal(nextWord);
        // Only extend the buffer if it was already aligned with the
        // line — otherwise we'd end up with just the appended word,
        // which the next Enter would then record as the command.
        if (typedBufferReliableRef.current) {
          typedInputBufferRef.current += nextWord;
        }
        // Shrink the ghost to reflect what's left after the accept.
        const newInput = base + nextWord;
        if (fullSuggestion.startsWith(newInput) && fullSuggestion.length > newInput.length) {
          ghost.show(fullSuggestion, newInput);
        } else {
          ghost.hide();
        }
      }
      return false;
    }
  }

  // Tab: accept selected popup suggestion. Ghost text is accepted via → only —
  // letting Tab pass through lets the shell's native completion (bash/zsh) run,
  // which is otherwise shadowed by our single-Tab ghost accept.
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && s.subDirFocusLevel < 0) {
    if (s.popupVisible && s.suggestions.length > 0) {
      // #1005: don't intercept Tab. Keep whatever is currently rendered on
      // the line and let Tab reach the shell for native completion.
      clearState();
      previewActiveRef.current = false;
      return true;
    }
    // Hide stale ghost text before Tab reaches the shell — the shell's
    // completion will rewrite the line and the old ghost would mislead.
    if (ghost?.isActive()) {
      ghost.hide();
    }
  }

  // Up/Down/Left/Right: navigate popup + sub-dir panel
  if (s.popupVisible && s.suggestions.length > 0) {

    const focusLevel = s.subDirFocusLevel;
    const focusedPanel = focusLevel >= 0 ? s.subDirPanels[focusLevel] : null;

    // Sub-dir panel focused: ↑↓ navigate, ← go back, → go deeper
    if (focusLevel >= 0 && focusedPanel) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const newIdx = e.key === "ArrowUp"
          ? (focusedPanel.selectedIndex <= 0 ? focusedPanel.entries.length - 1 : focusedPanel.selectedIndex - 1)
          : (focusedPanel.selectedIndex >= focusedPanel.entries.length - 1 ? 0 : focusedPanel.selectedIndex + 1);
        setState((prev) => {
          const panels = [...prev.subDirPanels];
          const p = panels[focusLevel];
          if (!p) return prev;
          panels[focusLevel] = { ...p, selectedIndex: newIdx };
          return { ...prev, subDirPanels: panels.slice(0, focusLevel + 1) };
        });
        // Live-render the highlighted entry's full path into the line (#1005).
        const newEntry = focusedPanel.entries[newIdx];
        if (newEntry && settingsRef.current.livePreview) renderSubDirPath(focusLevel, newEntry);
        // Auto-expand next level if the newly selected item is a directory
        if (newEntry?.type === "directory") {
          expandSubDir(focusLevel, newEntry);
        }
        return false;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setState((prev) => ({
          ...prev,
          subDirPanels: prev.subDirPanels.slice(0, focusLevel + 1),
          subDirFocusLevel: focusLevel - 1,
        }));
        return false;
      }
      if (e.key === "ArrowRight") {
        const entry = focusedPanel.entries[focusedPanel.selectedIndex];
        if (entry?.type === "directory") {
          e.preventDefault();
          expandSubDir(focusLevel, entry, true); // moveFocus = true
          return false;
        }
      }
      if (isAutocompleteConfirmEnter(e, settingsRef.current) || e.key === "Tab") {
        const entry = focusedPanel.entries[focusedPanel.selectedIndex];
        if (entry && focusedPanel.selectedIndex >= 0) {
          e.preventDefault();
          handleSubDirSelect(focusLevel, entry);
          return false;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (focusLevel > 0) {
          setState((prev) => ({
            ...prev,
            subDirPanels: prev.subDirPanels.slice(0, focusLevel),
            subDirFocusLevel: focusLevel - 1,
          }));
        } else {
          setState((prev) => ({ ...prev, subDirPanels: [], subDirFocusLevel: -1 }));
        }
        return false;
      }
      if (
        e.key.length === 1 ||
        e.key === "Backspace" ||
        e.key === "Delete" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        clearState();
      }
      return true;
    }

    // Main panel navigation. The cycle includes a -1 "no selection" slot so
    // ↑ off the top / ↓ off the bottom reverts to the typed baseline. Moving
    // the selection live-renders the candidate into the command line (#1005).
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = s.suggestions.length;
      const cur = s.selectedIndex;
      const next =
        e.key === "ArrowDown"
          ? (cur >= n - 1 ? -1 : cur + 1)
          : (cur <= -1 ? n - 1 : cur - 1);
      setState((prev) => ({
        ...prev,
        selectedIndex: next,
        subDirPanels: [], subDirFocusLevel: -1,
      }));
      if (settingsRef.current.livePreview) renderPreviewSelection(next);
      if (next >= 0) fetchSubDirForIndex(next);
      return false;
    }

    // Enter on popup. The selected candidate is already rendered into the
    // line by live-preview, so let Enter reach the shell. Don't record here:
    // handleInput's Enter path records the *actual* line — it uses
    // lastAcceptedCommandRef (set on select) but falls back to the live
    // buffer when the user edited the previewed command (typing nulls that
    // ref), so recording stays accurate in both cases.
    if (isAutocompleteConfirmEnter(e, settingsRef.current)) {
      const selected = s.selectedIndex >= 0 ? s.suggestions[s.selectedIndex] : null;
      if (selected?.source === "snippet" && selected.snippet) {
        if (!acceptSnippet(selected.snippet)) {
          clearState();
          previewActiveRef.current = false;
          return true;
        }
        e.preventDefault();
        previewActiveRef.current = false;
        return false; // consume — run the snippet, not the typed text
      }
      if (!settingsRef.current.livePreview && selected) {
        if (acceptPreviewlessSelection(s.selectedIndex)) {
          e.preventDefault();
          previewActiveRef.current = false;
          return false;
        }
        clearState();
        previewActiveRef.current = false;
        return true;
      }
      clearState();
      previewActiveRef.current = false;
      return true;
    }
  }

  // Escape: close popup and hide ghost text
  // Only consume Escape if popup is visible; don't block Escape for vi-mode shells
  // when only ghost text is showing (ghost text is passive/non-intrusive)
  if (e.key === "Escape" && s.popupVisible) {
    e.preventDefault();
    if (previewActiveRef.current) {
      renderPreviewSelection(-1); // restore the typed baseline
    }
    ghost?.hide();
    clearState();
    previewActiveRef.current = false;
    return false;
  }

  return true;
}
