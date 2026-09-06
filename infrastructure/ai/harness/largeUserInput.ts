import type { ToolOutputStore } from './toolOutputStore';

const LARGE_USER_INPUT_THRESHOLD_CHARS = 25_000;
const LARGE_USER_INPUT_HEAD_CHARS = 12_000;
const LARGE_USER_INPUT_TAIL_CHARS = 4_000;

const handlesByStore = new WeakMap<ToolOutputStore, Map<string, string>>();

function hashInput(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function getStableHandleId(
  input: string,
  chatSessionId: string,
  toolOutputStore: ToolOutputStore,
): string {
  const handles = handlesByStore.get(toolOutputStore) ?? new Map<string, string>();
  handlesByStore.set(toolOutputStore, handles);
  const key = `${chatSessionId}:${input.length}:${hashInput(input)}`;
  const existingId = handles.get(key);
  if (existingId && toolOutputStore.get(existingId, chatSessionId)) return existingId;

  const handleId = toolOutputStore.store({
    chatSessionId,
    capabilityId: 'user.input',
    content: input,
  }).id;
  handles.set(key, handleId);
  return handleId;
}

export function fitLargeUserInputForModel(
  input: string,
  chatSessionId: string,
  toolOutputStore: ToolOutputStore,
): string {
  if (input.length <= LARGE_USER_INPUT_THRESHOLD_CHARS) return input;
  const handleId = getStableHandleId(input, chatSessionId, toolOutputStore);
  return [
    input.slice(0, LARGE_USER_INPUT_HEAD_CHARS),
    `\n\n[... large user input moved to saved output: ${input.length} chars, handleId=${handleId}. Use tool_output_read with range or search for omitted details ...]\n\n`,
    input.slice(-LARGE_USER_INPUT_TAIL_CHARS),
  ].join('');
}

// The external SDK backends (claude-code, codex, grok, ...) have no
// `tool_output_read` tool, so the handle path above cannot be used there.
// Instead the prompt is hard-bounded before it is sent or steered: external
// model context windows vary and a full 768 KiB vault-note payload plus
// history can exceed the smallest of them, which fails the whole turn with a
// request/context-too-large error.
const EXTERNAL_PROMPT_MAX_CHARS = 100_000;
const EXTERNAL_PROMPT_HEAD_CHARS = 80_000;
const EXTERNAL_PROMPT_TAIL_CHARS = 16_000;

// External SDK prompts inline Vault note mentions as
// `[Vault Note: <title> (id: <noteId>)]` blocks. A head/tail cut can drop a
// block's header while keeping part of its body, leaving the tail unlabeled
// and its note id unrecoverable (external agents have no `tool_output_read`
// recovery path), so every lost header is collected and re-stated in the
// truncation notice; the header owning the retained tail is kept even when
// the notice budget forces the others out (see `boundPromptForExternalSdk`).
// A pathological single-line `[Vault Note: ...]` sequence can be arbitrarily
// long; restoring it verbatim would defeat the prompt bound, so each restored
// header is capped (keeping the `[Vault Note: ` prefix and the `(id: ...)]`
// tail so the note id stays recoverable).
const EXTERNAL_PROMPT_MAX_NOTE_HEADER_CHARS = 400;
const NOTE_HEADER_PATTERN = /\[Vault Note: [^\]\n]*\]/g;

/** Cap a restored note header, keeping its prefix and id-bearing tail. */
function capNoteHeader(header: string): string {
  if (header.length <= EXTERNAL_PROMPT_MAX_NOTE_HEADER_CHARS) return header;
  const keep = Math.floor((EXTERNAL_PROMPT_MAX_NOTE_HEADER_CHARS - 1) / 2);
  return `${header.slice(0, keep)}…${header.slice(-keep)}`;
}

/** Collect note headers that the head/tail cut does not show in full. */
function collectLostNoteHeaders(prompt: string, headLength: number, tailStart: number): string[] {
  const lost: string[] = [];
  NOTE_HEADER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NOTE_HEADER_PATTERN.exec(prompt)) !== null) {
    const end = match.index + match[0].length;
    // A header is preserved only if the cut hides it (fully or partially):
    // headers shown in full already carry their title and id.
    const fullyVisible = end <= headLength || match.index >= tailStart;
    if (!fullyVisible && !lost.includes(match[0])) lost.push(match[0]);
  }
  return lost;
}

/**
 * The header straddling the tail cut owns the visible tail fragment, so its
 * title and id must be re-stated even when the notice budget drops every
 * other lost header. Returns null when no header spans `tailStart`.
 */
function findTailNoteHeader(prompt: string, tailStart: number): string | null {
  NOTE_HEADER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NOTE_HEADER_PATTERN.exec(prompt)) !== null) {
    if (match.index >= tailStart) break;
    if (match.index + match[0].length > tailStart) return match[0];
  }
  return null;
}

/** Hard-bound an external SDK prompt, keeping both ends and never splitting a surrogate pair. */
export function boundPromptForExternalSdk(prompt: string): string {
  if (prompt.length <= EXTERNAL_PROMPT_MAX_CHARS) return prompt;
  let head = prompt.slice(0, EXTERNAL_PROMPT_HEAD_CHARS);
  let tail = prompt.slice(-EXTERNAL_PROMPT_TAIL_CHARS);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  const omitted = prompt.length - head.length - tail.length;
  const tailStart = prompt.length - tail.length;
  const lostNoteHeaders = collectLostNoteHeaders(prompt, head.length, tailStart).map(capNoteHeader);
  const tailNoteHeader = findTailNoteHeader(prompt, tailStart);
  if (tailNoteHeader !== null) {
    const cappedTailNoteHeader = capNoteHeader(tailNoteHeader);
    // Dedup may have folded the tail-owning header into an earlier identical
    // entry (or it may be missing entirely when capping collided); make sure
    // its text is present so the visible tail fragment stays labeled.
    if (!lostNoteHeaders.includes(cappedTailNoteHeader)) lostNoteHeaders.push(cappedTailNoteHeader);
  }
  const noticePrefix = `\n\n[... prompt truncated for size: showing the first ${head.length} and last ${tail.length} of ${prompt.length} characters (${omitted} omitted).`;
  const noticeSuffix = ' If a Vault note attachment above looks incomplete, ask the user to share the missing part ...]\n\n';
  const headersNotePrefix = ' Omitted Vault note headers: ';
  // Enforce the final output bound: the restored headers must fit in the
  // remaining budget. Headers near the head are the least valuable (their
  // opening text is still visible in the head), so drop those first; the
  // last entry — the header owning the retained tail — is always kept, and
  // the per-header cap (400 chars) keeps it within the ~3.7k remaining
  // budget, so the output bound cannot be exceeded.
  const maxHeadersNoteLength = Math.max(
    0,
    EXTERNAL_PROMPT_MAX_CHARS - head.length - tail.length - noticePrefix.length - noticeSuffix.length,
  );
  const restoredHeaders: string[] = [];
  let restoredLength = headersNotePrefix.length;
  for (let index = lostNoteHeaders.length - 1; index >= 0; index -= 1) {
    const header = lostNoteHeaders[index];
    const nextLength = restoredLength + header.length + (restoredHeaders.length > 0 ? 1 : 0);
    if (restoredHeaders.length > 0 && nextLength > maxHeadersNoteLength) break;
    restoredHeaders.unshift(header);
    restoredLength = nextLength;
  }
  const lostNoteHeadersNote = restoredHeaders.length > 0
    ? `${headersNotePrefix}${restoredHeaders.join(' ')}`
    : '';
  return [
    head,
    `${noticePrefix}${lostNoteHeadersNote}${noticeSuffix}`,
    tail,
  ].join('');
}
