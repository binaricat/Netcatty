import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCurrentSqlStatement, extractSqlTableAliases } from './sqlStatement';

test('extractCurrentSqlStatement splits statements respecting strings, comments, and PG dollar quotes', () => {
  const sql = [
    "-- first query; not a split",
    "SELECT 'semi;colon' AS a;",
    "CREATE FUNCTION f() RETURNS text AS $$ BEGIN RETURN 'x;y'; END; $$ LANGUAGE plpgsql;",
    "SELECT /* block; comment */ * FROM orders WHERE id = 1",
  ].join('\n');

  const firstIdx = sql.indexOf("SELECT 'semi");
  assert.equal(extractCurrentSqlStatement(sql, firstIdx + 5), "-- first query; not a split\nSELECT 'semi;colon' AS a");

  const fnIdx = sql.indexOf("RETURN 'x;y'");
  assert.equal(
    extractCurrentSqlStatement(sql, fnIdx),
    "CREATE FUNCTION f() RETURNS text AS $$ BEGIN RETURN 'x;y'; END; $$ LANGUAGE plpgsql",
  );

  const lastIdx = sql.indexOf('FROM orders');
  assert.equal(
    extractCurrentSqlStatement(sql, lastIdx),
    'SELECT /* block; comment */ * FROM orders WHERE id = 1',
  );
});

test('extractSqlTableAliases resolves table names and aliases across FROM and JOIN clauses', () => {
  const sql = 'SELECT o.id, u.email FROM public.orders AS o INNER JOIN users u ON u.id = o.user_id WHERE o.status = 1';
  const aliases = extractSqlTableAliases(sql);
  assert.equal(aliases.get('o'), 'orders');
  assert.equal(aliases.get('orders'), 'orders');
  assert.equal(aliases.get('u'), 'users');
  assert.equal(aliases.get('users'), 'users');
  assert.equal(aliases.has('where'), false);
});
