import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVaultNote } from './vaultNoteRead';

const note = { id: 'note-1', title: 'Runbook', content: '', createdAt: 1, updatedAt: 2 };

function read(...args: Parameters<typeof readVaultNote>) {
  const result = readVaultNote(...args);
  assert.ok('note' in result, JSON.stringify(result));
  return result;
}

test('bounded pages reconstruct long Unicode notes without gaps or broken characters', () => {
  const content = `${'a'.repeat(5999)}\u{1F408}中文\n`.repeat(20);
  let offset: number | null = 0;
  let collected = '';
  while (offset !== null) {
    const result = read({ ...note, content }, { offset, maxChars: 1_000_000, expectedUpdatedAt: 2 });
    assert.ok(result.note);
    assert.equal(result.offset, offset);
    assert.ok(result.note.content.length <= 6000);
    assert.doesNotMatch(result.note.content, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    collected += result.note.content;
    offset = result.nextOffset;
  }
  assert.equal(collected, content);
});

test('small/empty notes and EOF are complete, and oversized metadata stays out', () => {
  for (const content of ['', 'small note']) {
    const result = read({ ...note, content, title: 'x'.repeat(100_000), tags: ['x'.repeat(100_000)] }, {});
    assert.ok(result.note);
    assert.equal(result.note.content, content);
    assert.equal(result.nextOffset, null);
    assert.ok(JSON.stringify(result).length < 1000);
  }
  assert.equal(read({ ...note, content: 'abc' }, { offset: 3 }).note?.content, '');
});

test('literal search locates later and overlapping hits without skipping nearby matches', () => {
  const source = { ...note, content: `${'x'.repeat(9000)}ababa\u{1F408}tail` };
  const first = read(source, { query: 'aba', maxChars: 4 });
  assert.equal(first.matchOffset, 9000);
  assert.equal(first.note?.content, 'abab');
  const second = read(source, { query: 'aba', offset: first.nextOffset, expectedUpdatedAt: 2 });
  assert.equal(second.matchOffset, 9002);
  const missing = read(source, { query: 'aba', offset: second.nextOffset });
  assert.equal(missing.matchOffset, null);
  assert.equal(missing.nextOffset, null);
  assert.equal(missing.note?.content, '');
  assert.equal(read(source, { query: 'ABA' }).matchOffset, null);
  assert.equal(read(source, { query: '.*' }).matchOffset, null);
});

test('invalid ranges, queries and changed notes fail explicitly', () => {
  const source = { ...note, content: 'a\u{1F408}b' };
  for (const params of [
    { offset: -1 }, { offset: 0.5 }, { offset: 9 }, { offset: 2 }, { offset: '1' },
    { maxChars: 0 }, { maxChars: NaN }, { maxChars: Infinity },
    { query: '' }, { query: 'a'.repeat(201) }, { query: 1 }, { expectedUpdatedAt: 1 },
  ]) assert.equal(readVaultNote(source, params).ok, false, JSON.stringify(params));
});
