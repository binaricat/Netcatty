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
// recovery path), so the lost headers are re-stated in the truncation notice.
const EXTERNAL_PROMPT_MAX_LOST_NOTE_HEADERS = 10;
const NOTE_HEADER_PATTERN = /\[Vault Note: [^\]\n]*\]/g;

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
    if (!fullyVisible && !lost.includes(match[0])) {
      lost.push(match[0]);
      if (lost.length >= EXTERNAL_PROMPT_MAX_LOST_NOTE_HEADERS) break;
    }
  }
  return lost;
}

/** Hard-bound an external SDK prompt, keeping both ends and never splitting a surrogate pair. */
export function boundPromptForExternalSdk(prompt: string): string {
  if (prompt.length <= EXTERNAL_PROMPT_MAX_CHARS) return prompt;
  let head = prompt.slice(0, EXTERNAL_PROMPT_HEAD_CHARS);
  let tail = prompt.slice(-EXTERNAL_PROMPT_TAIL_CHARS);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  const omitted = prompt.length - head.length - tail.length;
  const lostNoteHeaders = collectLostNoteHeaders(prompt, head.length, prompt.length - tail.length);
  const lostNoteHeadersNote = lostNoteHeaders.length > 0
    ? ` Omitted Vault note headers: ${lostNoteHeaders.join(' ')}`
    : '';
  return [
    head,
    `\n\n[... prompt truncated for size: showing the first ${head.length} and last ${tail.length} of ${prompt.length} characters (${omitted} omitted).${lostNoteHeadersNote} If a Vault note attachment above looks incomplete, ask the user to share the missing part ...]\n\n`,
    tail,
  ].join('');
}
