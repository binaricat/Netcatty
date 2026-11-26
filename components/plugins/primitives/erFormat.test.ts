import assert from 'node:assert/strict';
import test from 'node:test';
import { abbreviateSqlType, buildStandaloneErSvg } from './erFormat';
import { matchWorkbenchShortcut } from './shortcuts';

test('abbreviateSqlType shortens verbose SQL catalog types cleanly without mid-word clipping', () => {
  assert.equal(abbreviateSqlType('character varying(180)'), 'varchar(180)');
  assert.equal(abbreviateSqlType('timestamp with time zone'), 'timestamptz');
  assert.equal(abbreviateSqlType('timestamp without time zone'), 'timestamp');
  assert.equal(abbreviateSqlType('double precision'), 'float8');
  assert.equal(abbreviateSqlType('integer'), 'int4');
  assert.equal(abbreviateSqlType('boolean'), 'bool');
  assert.equal(abbreviateSqlType('numeric(10,2)'), 'numeric(10,2)');
});

test('buildStandaloneErSvg generates valid self-contained SVG markup with tables, PK/FK pills, and Bezier relations', () => {
  const svg = buildStandaloneErSvg(
    [
      { name: 'customers', schema: 'public', columns: [{ name: 'id', type: 'integer', isPk: true }, { name: 'email', type: 'character varying(180)', nullable: false }] },
      { name: 'orders', schema: 'public', columns: [{ name: 'id', type: 'integer', isPk: true }, { name: 'customer_id', type: 'integer', isFk: true }] },
    ],
    [{ fromTable: 'public.orders', fromColumn: 'customer_id', toTable: 'public.customers', toColumn: 'id', onDelete: 'CASCADE' }],
    { 'public.customers': { x: 40, y: 40 }, 'public.orders': { x: 380, y: 40 } },
    {
      background: '#0f1117',
      card: '#161922',
      cardForeground: '#f1f5f9',
      muted: '#1e2230',
      mutedForeground: '#94a3b8',
      border: '#2a3040',
      primary: '#38bdf8',
    },
  );
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /public\.customers/);
  assert.match(svg, /varchar\(180\)/);
  assert.match(svg, />PK</);
  assert.match(svg, />FK</);
  assert.match(svg, /<path d="M /);
});

test('matchWorkbenchShortcut normalizes mod+k/s/t/w/z/shift+z and escape while respecting includeUndoRedo', () => {
  assert.equal(matchWorkbenchShortcut({ key: 'k', metaKey: true }), 'mod+k');
  assert.equal(matchWorkbenchShortcut({ key: 'K', ctrlKey: true }), 'mod+k');
  assert.equal(matchWorkbenchShortcut({ key: 's', metaKey: true }), 'mod+s');
  assert.equal(matchWorkbenchShortcut({ key: 't', ctrlKey: true }), 'mod+t');
  assert.equal(matchWorkbenchShortcut({ key: 'w', metaKey: true }), 'mod+w');
  assert.equal(matchWorkbenchShortcut({ key: 'z', metaKey: true }), 'mod+z');
  assert.equal(matchWorkbenchShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'mod+shift+z');
  assert.equal(matchWorkbenchShortcut({ key: 'y', ctrlKey: true }), 'mod+shift+z');
  assert.equal(matchWorkbenchShortcut({ key: 'Escape' }), 'escape');
  assert.equal(matchWorkbenchShortcut({ key: 'z', metaKey: true }, { includeUndoRedo: false }), null);
  assert.equal(matchWorkbenchShortcut({ key: 'c', metaKey: true }), null);
});
