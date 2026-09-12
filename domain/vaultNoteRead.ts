import type { VaultNote } from './models';

// Stay below the shared tool fitter's 8,000-character string limit.
export const MAX_NOTE_READ_CHARS = 6000;

/** Bounded reads use JavaScript (UTF-16) offsets, including for literal search. */
export function readVaultNote(note: VaultNote, params: Record<string, unknown>) {
  const offset = params.offset ?? 0;
  const maxChars = params.maxChars ?? MAX_NOTE_READ_CHARS;
  const query = params.query;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > note.content.length) {
    return { ok: false, error: 'offset must be an integer within the note content.' };
  }
  if (typeof maxChars !== 'number' || !Number.isSafeInteger(maxChars) || maxChars < 2) {
    return { ok: false, error: 'maxChars must be an integer of at least 2 (capped at 6000).' };
  }
  if (query !== undefined && (typeof query !== 'string' || query.length === 0 || query.length > 200)) {
    return { ok: false, error: 'query must be a nonempty literal string of at most 200 characters.' };
  }
  if (params.expectedUpdatedAt !== undefined && params.expectedUpdatedAt !== note.updatedAt) {
    return { ok: false, error: 'The note changed. Restart reading from offset 0 without expectedUpdatedAt.' };
  }
  const splitsPair = (position: number) => position > 0
    && /[\uD800-\uDBFF]/.test(note.content[position - 1] ?? '')
    && /[\uDC00-\uDFFF]/.test(note.content[position] ?? '');
  if (splitsPair(offset)) return { ok: false, error: 'offset splits a Unicode character. Use the returned nextOffset.' };

  const matchOffset = typeof query === 'string' ? note.content.indexOf(query, offset) : undefined;
  let start = matchOffset === undefined ? offset : matchOffset < 0 ? note.content.length : matchOffset;
  if (splitsPair(start)) start -= 1;
  let end = Math.min(note.content.length, start + Math.min(maxChars, MAX_NOTE_READ_CHARS));
  if (splitsPair(end)) end -= 1;
  let nextOffset: number | null = end < note.content.length ? end : null;
  if (matchOffset !== undefined) {
    // Advance past the match start, not the excerpt, so nearby/overlapping hits remain discoverable.
    let searchFrom = matchOffset + 1;
    if (splitsPair(searchFrom)) searchFrom += 1;
    nextOffset = matchOffset >= 0 && searchFrom < note.content.length ? searchFrom : null;
  }
  return {
    ok: true,
    // Large optional metadata must not defeat the body limit.
    note: { id: note.id, title: Array.from(note.title).slice(0, 120).join(''),
      content: note.content.slice(start, end), createdAt: note.createdAt, updatedAt: note.updatedAt },
    offset: start,
    endOffset: end,
    totalChars: note.content.length,
    nextOffset,
    hasMore: nextOffset !== null,
    ...(matchOffset === undefined ? {} : { matchOffset: matchOffset < 0 ? null : matchOffset }),
  };
}
