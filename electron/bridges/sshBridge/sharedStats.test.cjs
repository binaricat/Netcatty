'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleSharedStats, readSharedStats, cancelSharedStats, resetSharedStatsForTests } = require('./sharedStats.cjs');

const endpoint = { hostname: 'stats.example', username: 'test', port: 22 };
const result = cpu => ({ success: true, stats: { cpu, memTotal: 100, memUsed: 50 } });

test('new transport samples without waiting for an old same-endpoint request', async () => {
  resetSharedStatsForTests();
  const oldConn = {}, newConn = {};
  let finishOld;
  let oldContext;
  const old = sampleSharedStats({ conn: oldConn, _reuseEndpoint: endpoint }, context => {
    oldContext = context;
    return new Promise(resolve => { finishOld = resolve; });
  });
  let newCalls = 0;
  const fresh = await sampleSharedStats({ conn: newConn, _reuseEndpoint: endpoint }, async context => {
    newCalls++;
    assert.equal(context.conn, newConn);
    return result(80);
  });
  assert.equal(newCalls, 1);
  assert.equal(fresh.stats.cpu, 80);
  assert.equal(oldContext.statsSignal.aborted, false);
  finishOld(result(10));
  await old;
  assert.equal(readSharedStats(newConn).result.stats.cpu, 80, 'late old reply must not replace newer measurements');
  assert.equal(readSharedStats(oldConn).points, readSharedStats(newConn).points);
});

test('a failed replacement sample still retires pending results from the old transport', async () => {
  resetSharedStatsForTests();
  const oldConn = {}, newConn = {};
  await sampleSharedStats({ conn: oldConn, _reuseEndpoint: endpoint }, async () => result(42));
  const before = readSharedStats(oldConn);
  const now = Date.now() + 5000;
  let finishOld;
  const old = sampleSharedStats({ conn: oldConn, _reuseEndpoint: endpoint }, () =>
    new Promise(resolve => { finishOld = resolve; }), now);
  const failed = await sampleSharedStats({ conn: newConn, _reuseEndpoint: endpoint }, async () =>
    ({ success: false, error: 'Connection closed' }), now);
  assert.equal(failed.success, false);
  finishOld(result(10));
  await old;
  const after = readSharedStats(newConn);
  assert.equal(after.result.stats.cpu, 42, 'keep the last published measurement');
  assert.equal(after.at, before.at);
  assert.deepEqual(after.points.map(point => point.cpu), [42], 'do not publish a late old sample');
});

test('cancelling a monitor on one transport cannot abort another transport', async () => {
  resetSharedStatsForTests();
  const a = {}, b = {};
  const contexts = [];
  const finish = [];
  const collect = context => {
    contexts.push(context);
    return new Promise(resolve => finish.push(resolve));
  };
  const first = sampleSharedStats({ conn: a, _reuseEndpoint: endpoint, _monitorStats: true }, collect);
  const second = sampleSharedStats({ conn: b, _reuseEndpoint: endpoint, _monitorStats: true }, collect);
  assert.equal(contexts.length, 2);
  cancelSharedStats(a);
  assert.equal(contexts[0].statsSignal.aborted, true);
  assert.equal(contexts[1].statsSignal.aborted, false);
  finish[0](result(10));
  finish[1](result(80));
  await Promise.all([first, second]);
  assert.equal(readSharedStats(b).result.stats.cpu, 80);
});

test('readers sharing one physical transport still coalesce an active sample', async () => {
  resetSharedStatsForTests();
  const conn = {};
  let resolve;
  let calls = 0;
  const collect = () => { calls++; return new Promise(done => { resolve = done; }); };
  const a = sampleSharedStats({ conn, _reuseEndpoint: endpoint }, collect);
  const b = sampleSharedStats({ conn, _reuseEndpoint: endpoint }, collect);
  assert.equal(calls, 1);
  resolve(result(42));
  assert.deepEqual(await a, await b);
});

test('a snapshot read before sampling still joins the existing endpoint history', async () => {
  resetSharedStatsForTests();
  const terminal = {}, monitor = {};
  await sampleSharedStats({ conn: terminal, _reuseEndpoint: endpoint }, async () => result(42));
  assert.equal(readSharedStats(monitor).result, null);
  await sampleSharedStats({ conn: monitor, _reuseEndpoint: endpoint }, async () => result(80));
  assert.equal(readSharedStats(monitor).points, readSharedStats(terminal).points);
  assert.equal(readSharedStats(monitor).result.stats.cpu, 42);
});

test('one-second requests never overlap and keep disk baselines on the physical transport', async () => {
  resetSharedStatsForTests();
  const conn = {};
  let release;
  let calls = 0;
  const contexts = [];
  const collect = context => {
    calls++;
    contexts.push(context);
    const previous = context.prevDiskIo;
    context.prevDiskIo = { timestamp: calls };
    return new Promise(resolve => { release = () => resolve({ success: true, stats: { diskReadSpeed: previous ? 512 : null, diskWriteSpeed: previous ? 1024 : null } }); });
  };
  const session = { conn, _monitorStats: true, _monitorIntervalMs: 1000 };
  const first = sampleSharedStats(session, collect, 1000);
  const overlapping = sampleSharedStats(session, collect, 2000);
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, overlapping]);
  assert.equal(a, b);
  assert.equal(a.stats.diskReadSpeed, null);
  const next = sampleSharedStats(session, collect, Date.now() + 1001);
  assert.equal(calls, 2);
  release();
  assert.equal((await next).stats.diskReadSpeed, 512);
  const reconnect = sampleSharedStats({ ...session, conn: {} }, collect, Date.now() + 2002);
  assert.equal(calls, 3);
  assert.notEqual(contexts[0], contexts[2]);
  release();
  assert.equal((await reconnect).stats.diskReadSpeed, null);
});

test('a newly established companion transport retains partition I/O baselines', async () => {
  resetSharedStatsForTests();
  const conn = {};
  const baseline = { timestamp: 1, devices: new Map() };
  const session = { _monitorStats: true, _monitorIntervalMs: 1000 };
  await sampleSharedStats(session, async context => {
    context.moshStatsConn = conn;
    context.prevPartitionIo = baseline;
    return result(42);
  });
  let sampled = false;
  await sampleSharedStats(session, async context => {
    sampled = true;
    assert.equal(context.prevPartitionIo, baseline);
    return result(43);
  }, Date.now() + 1001);
  assert.equal(sampled, true);
});
