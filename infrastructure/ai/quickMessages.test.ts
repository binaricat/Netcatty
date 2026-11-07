import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSlashCommandItems,
  filterQuickMessages,
  getRebindSlashCommandArg,
  getRenameSlashCommandTitle,
  getSystemSlashCommand,
  isValidQuickMessageSlug,
  normalizeQuickMessageSlug,
  sanitizeQuickMessages,
  slugFromQuickMessageName,
} from './quickMessages';

test('normalizeQuickMessageSlug lowercases and hyphenates', () => {
  assert.equal(normalizeQuickMessageSlug('Check Disk Space'), 'check-disk-space');
  assert.equal(normalizeQuickMessageSlug('  foo__bar!!  '), 'foo-bar');
});

test('slugFromQuickMessageName mirrors normalize', () => {
  assert.equal(slugFromQuickMessageName('Check Disk'), 'check-disk');
});

test('isValidQuickMessageSlug accepts simple tokens', () => {
  assert.equal(isValidQuickMessageSlug('disk-check'), true);
  assert.equal(isValidQuickMessageSlug('Disk'), false);
  assert.equal(isValidQuickMessageSlug(''), false);
});

test('filterQuickMessages matches slug prefix and name substring', () => {
  const messages = [
    { id: '1', name: 'Check disk', slug: 'disk', content: 'df -h' },
    { id: '2', name: 'List processes', slug: 'ps', content: 'ps aux' },
  ];
  assert.equal(filterQuickMessages(messages, 'di').length, 1);
  assert.equal(filterQuickMessages(messages, 'proc').length, 1);
  assert.equal(filterQuickMessages(messages, '').length, 2);
});

test('sanitizeQuickMessages rejects invalid and dedupes slugs', () => {
  const result = sanitizeQuickMessages([
    { id: '1', name: 'Valid', slug: 'valid', content: 'hello' },
    { id: '2', name: 'Duplicate', slug: 'valid', content: 'ignored' },
    { id: '3', name: '', slug: 'empty', content: 'nope' },
    { id: '4', name: 'Bad slug', slug: '!!!', content: 'nope' },
    null,
    'not-an-object',
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.slug, 'valid');
});

test('buildSlashCommandItems prefers quick messages over conflicting skill slugs', () => {
  const items = buildSlashCommandItems(
    [{ id: '1', name: 'Disk', slug: 'disk', content: 'df -h' }],
    [{ id: 's1', slug: 'disk', name: 'Disk skill', description: '' }],
    '',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'quickMessage');
});

test('buildSlashCommandItems excludes skills whose slug matches any quick message', () => {
  const items = buildSlashCommandItems(
    [{ id: '1', name: 'Disk check', slug: 'disk', content: 'df -h' }],
    [{ id: 's1', slug: 'disk', name: 'Disk skill label', description: '' }],
    'label',
  );
  assert.equal(items.length, 0);
});

test('buildSlashCommandItems includes built-in commands for the composer picker', () => {
  const items = buildSlashCommandItems([], [], 'com', true);
  assert.deepEqual(items.map((item) => item.kind === 'system' ? item.command.slug : item.kind), ['compact']);
});

test('getSystemSlashCommand recognizes /compact and /stop only', () => {
  assert.equal(getSystemSlashCommand('/compact'), 'compact');
  assert.equal(getSystemSlashCommand('  /Compact  '), 'compact');
  assert.equal(getSystemSlashCommand('/compact now'), null);
  assert.equal(getSystemSlashCommand('/stop'), 'stop');
  assert.equal(getSystemSlashCommand('/stop please'), 'stop');
  assert.equal(getSystemSlashCommand('/stopx'), null);
  assert.equal(getSystemSlashCommand('/clear'), null);
  assert.equal(getSystemSlashCommand('/compress'), null);
});

test('getSystemSlashCommand recognizes /rename with an argument and bare /chats', () => {
  assert.equal(getSystemSlashCommand('/rename'), 'rename');
  assert.equal(getSystemSlashCommand('/rename New title'), 'rename');
  assert.equal(getSystemSlashCommand('  /RENAME  stuff  '), 'rename');
  assert.equal(getSystemSlashCommand('/renamex'), null);
  assert.equal(getSystemSlashCommand('/chats'), 'chats');
  assert.equal(getSystemSlashCommand('  /Chats  '), 'chats');
  assert.equal(getSystemSlashCommand('/chats now'), null);
  assert.equal(getSystemSlashCommand('/chat'), null);
});

test('getRenameSlashCommandTitle extracts the argument and trims it', () => {
  assert.equal(getRenameSlashCommandTitle('/rename New title'), 'New title');
  assert.equal(getRenameSlashCommandTitle('  /RENAME   spaced  '), 'spaced');
  assert.equal(getRenameSlashCommandTitle('/rename'), '');
  assert.equal(getRenameSlashCommandTitle('/rename   '), '');
});

test('getSystemSlashCommand recognizes /rebind with an argument', () => {
  assert.equal(getSystemSlashCommand('/rebind'), 'rebind');
  assert.equal(getSystemSlashCommand('/rebind 2'), 'rebind');
  assert.equal(getSystemSlashCommand('  /Rebind   1  '), 'rebind');
  assert.equal(getSystemSlashCommand('/rebindx'), null);
  assert.equal(getSystemSlashCommand('/re'), null);
});

test('getRebindSlashCommandArg extracts the dangling entry number', () => {
  assert.equal(getRebindSlashCommandArg('/rebind 2'), '2');
  assert.equal(getRebindSlashCommandArg('  /REBIND   1  '), '1');
  assert.equal(getRebindSlashCommandArg('/rebind'), '');
  assert.equal(getRebindSlashCommandArg('/rebind   '), '');
});

test('buildSlashCommandItems reserves system slugs over quick messages and skills', () => {
  const emptyQuery = buildSlashCommandItems([], [], '', true);
  assert.deepEqual(
    emptyQuery.filter((item) => item.kind === 'system').map((item) => item.kind === 'system' ? item.command.slug : ''),
    ['compact', 'stop', 'rename', 'chats', 'rebind'],
  );

  const withCollision = buildSlashCommandItems(
    [{ id: '1', name: 'User compact', slug: 'compact', content: 'do not run' }],
    [{ id: 's1', slug: 'stop', name: 'Stop skill', description: '' }],
    '',
    true,
  );
  assert.deepEqual(
    withCollision.map((item) => (
      item.kind === 'system' ? `sys:${item.command.slug}`
        : item.kind === 'quickMessage' ? `qm:${item.message.slug}`
          : `sk:${item.skill.slug}`
    )),
    ['sys:compact', 'sys:stop', 'sys:rename', 'sys:chats', 'sys:rebind'],
  );
});

test('sanitizeQuickMessages returns empty array for non-array input', () => {
  assert.deepEqual(sanitizeQuickMessages(null), []);
  assert.deepEqual(sanitizeQuickMessages({}), []);
});
