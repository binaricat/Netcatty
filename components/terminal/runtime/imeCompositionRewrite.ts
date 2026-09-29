/**
 * xterm.js commits an IME textarea change with `newValue.replace(oldValue, "")`
 * and, on compositionend, skips `_dataAlreadySent.length` characters. Both
 * steps assume the IME only appends. Live transcription rewrites the whole
 * hypothesis ("我是真的" -> "我是真的牛逼"), so the utterance is written as the
 * interim, again as the full final string, and again as the tail (#3421).
 *
 * Append-only commits (punctuation, a normal compositionend) stay as they are.
 * A composition that continues a multi-character hypothesis already sent to
 * the PTY writes only the unsent suffix, and the in-flight textarea timer is
 * dropped so it cannot append that suffix a second time.
 */

const BACKSPACE = "\x7f";

export type ImeCompositionCommitTarget = {
  _textarea: { value: string };
  _compositionView: { classList: { remove(token: string): void } };
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _compositionPosition: { start: number; end: number };
  _compositionSuffix: string;
  _dataAlreadySent: string;
  _textareaChangeTimer?: ReturnType<typeof setTimeout>;
  __ncPendingPrevious?: string;
  _coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  compositionstart: () => void;
  __ncImeCommitInstalled?: boolean;
  __ncImeCommit?: ImeCompositionMarker;
};

export type ImeCompositionMarker = {
  /** A keydown-229 textarea timer was still pending when composition started. */
  continued: boolean;
  /** Textarea value that timer snapshotted — already reflected on the PTY. */
  pendingPrevious: string;
  alreadySent: string;
  textareaAtStart: string;
};

/**
 * PTY edit for one textarea rewrite.
 * A pure append sends the new suffix. A pure shrink sends one backspace per
 * deleted character, except a cleared textarea, which stays a single
 * backspace — xterm empties the textarea when a line is submitted, and that
 * reset is not a dictation rewrite. Any other rewrite deletes only the
 * diverging span and inserts its replacement, instead of `String.replace`
 * or the whole new value.
 */
export function commitTextareaChange(previous: string, next: string): string {
  if (previous === next) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.startsWith(next)) {
    if (next.length === 0) return BACKSPACE;
    return BACKSPACE.repeat(previous.length - next.length);
  }
  return rewriteDivergingSpan(previous, next);
}

export function rememberTextareaCommit(
  alreadySent: string,
  previous: string,
  sent: string,
): string {
  if (!sent) return alreadySent;
  let index = 0;
  while (sent.charCodeAt(index) === 0x7f) index += 1;
  const inserted = sent.slice(index);
  if (index > 0) return inserted;
  if (previous.endsWith(alreadySent)) return alreadySent + sent;
  return sent;
}

/**
 * Prefix of `compositionText` already on the PTY. Set only when composition
 * started while a 229 textarea timer was still pending, so this composition
 * finishes the update that timer snapshotted — not the next word.
 *
 * The timer's snapshot is the text already written. A later composition that
 * does not begin with that snapshot (normal pinyin after a finished line)
 * keeps every character. A hypothesis of one character is not treated as a
 * sentence being rewritten.
 */
export function continuedCompositionPrefix(
  marker: ImeCompositionMarker | undefined,
  compositionText: string,
): string {
  if (!marker?.continued) return "";
  if (
    marker.pendingPrevious.length >= 2
    && compositionText.startsWith(marker.pendingPrevious)
  ) {
    return marker.pendingPrevious;
  }
  if (
    marker.alreadySent.length >= 2
    && compositionText.startsWith(marker.alreadySent)
    && marker.textareaAtStart.endsWith(marker.alreadySent)
  ) {
    return marker.alreadySent;
  }
  return "";
}

function rewriteDivergingSpan(previous: string, next: string): string {
  let start = 0;
  const shared = Math.min(previous.length, next.length);
  while (start < shared && previous.charCodeAt(start) === next.charCodeAt(start)) {
    start += 1;
  }
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start
    && nextEnd > start
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return BACKSPACE.repeat(previousEnd - start) + next.slice(start, nextEnd);
}

function compositionSlice(
  helper: ImeCompositionCommitTarget,
  rangeStart: number,
  suffix: string,
  composingNow: boolean,
  newCompositionStart: number,
): string {
  const value = helper._textarea.value;
  if (composingNow) return value.substring(rangeStart, newCompositionStart);
  const valueEnd = suffix.length > 0 && value.endsWith(suffix)
    ? value.length - suffix.length
    : value.length;
  return value.substring(rangeStart, Math.max(rangeStart, valueEnd));
}

function deliverComposition(
  helper: ImeCompositionCommitTarget,
  compositionText: string,
  marker: ImeCompositionMarker | undefined,
): void {
  const continued = continuedCompositionPrefix(marker, compositionText);
  const live = !continued && helper._dataAlreadySent && compositionText.startsWith(helper._dataAlreadySent)
    ? helper._dataAlreadySent
    : "";
  const strip = continued || live;
  const data = strip ? compositionText.slice(strip.length) : compositionText;
  if (data.length > 0) helper._coreService.triggerDataEvent(data, true);
  if (!helper._isComposing) helper._dataAlreadySent = "";
}

/**
 * Installs the commit guard on one terminal. CompositionHelper is created in
 * `terminal.open()`, so this runs after open. Missing helpers (tests, log
 * view) are left untouched.
 */
export function keepLiveImeTranscriptionSingle(term: {
  _core?: { _compositionHelper?: ImeCompositionCommitTarget };
}): void {
  const helper = term._core?._compositionHelper;
  if (!helper || helper.__ncImeCommitInstalled || typeof helper.compositionstart !== "function") {
    return;
  }
  helper.__ncImeCommitInstalled = true;
  const originalStart = helper.compositionstart.bind(helper);

  helper.compositionstart = () => {
    const alreadySent = helper._dataAlreadySent;
    const pendingPrevious = helper.__ncPendingPrevious ?? "";
    const continued = helper._textareaChangeTimer !== undefined;
    if (helper._textareaChangeTimer !== undefined) {
      clearTimeout(helper._textareaChangeTimer);
      helper._textareaChangeTimer = undefined;
    }
    helper.__ncPendingPrevious = undefined;
    originalStart();
    helper.__ncImeCommit = {
      continued,
      pendingPrevious,
      alreadySent,
      textareaAtStart: helper._textarea.value,
    };
  };

  helper._handleAnyTextareaChanges = () => {
    if (helper._textareaChangeTimer !== undefined) return;
    const previous = helper._textarea.value;
    helper.__ncPendingPrevious = previous;
    helper._textareaChangeTimer = setTimeout(() => {
      helper._textareaChangeTimer = undefined;
      helper.__ncPendingPrevious = undefined;
      helper.__ncImeCommit = undefined;
      if (helper._isComposing || helper._isSendingComposition) return;
      const next = helper._textarea.value;
      const data = commitTextareaChange(previous, next);
      if (!data) return;
      helper._dataAlreadySent = rememberTextareaCommit(helper._dataAlreadySent, previous, data);
      helper._coreService.triggerDataEvent(data, true);
    }, 0);
  };

  helper._finalizeComposition = (waitForPropagation: boolean) => {
    const marker = helper.__ncImeCommit;
    helper.__ncImeCommit = undefined;
    helper._compositionView.classList.remove("active");
    helper._isComposing = false;

    if (!waitForPropagation) {
      helper._isSendingComposition = false;
      const compositionText = helper._textarea.value.substring(
        helper._compositionPosition.start,
        helper._compositionPosition.end,
      );
      deliverComposition(helper, compositionText, marker);
      return;
    }

    const rangeStart = helper._compositionPosition.start;
    const suffix = helper._compositionSuffix;
    const alreadySent = helper._dataAlreadySent;
    helper._isSendingComposition = true;
    setTimeout(() => {
      if (!helper._isSendingComposition) return;
      helper._isSendingComposition = false;
      const compositionText = compositionSlice(
        helper,
        rangeStart,
        suffix,
        helper._isComposing,
        helper._compositionPosition.start,
      );
      // compositionstart may have cleared the live field. The no-composition
      // path (#3191) still has the keydown commit in this snapshot.
      if (!marker && alreadySent) helper._dataAlreadySent = alreadySent;
      deliverComposition(helper, compositionText, marker);
    }, 0);
  };
}
