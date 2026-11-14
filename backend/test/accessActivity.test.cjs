const { test } = require('node:test');
const assert = require('node:assert/strict');
let visit, spans = [], log = [];
const now = new Date('2026-11-14T12:00:30Z');
const client = { async query(sql, args = []) {
  log.push(sql);
  if (sql.startsWith('SELECT * FROM app_access_visits')) return { rows: visit ? [visit] : [] };
  if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ server_now: now }] };
  if (sql.startsWith('INSERT INTO app_access_spans')) spans.push(args);
  return { rows: [] };
}, release() {} };
require.cache[require.resolve('../src/db')] = { exports: { query: async () => [], getPool: () => ({ connect: async () => client }) } };
const activity = require('../src/lib/accessActivity');
const prev = { last_seen_at: '2026-11-14T12:00:00Z', was_active: true };
test('Учитываются серверные интервалы; простой после пяти минут и потеря связи не увеличивают время', () => {
  assert.equal(activity.activeSlice(prev, now, { idleSeconds: 20 }).seconds, 30);
  assert.equal(activity.activeSlice(prev, now, { idleSeconds: 310 }).seconds, 20);
  assert.equal(activity.activeSlice(prev, now, { idleSeconds: 400 }), null);
  assert.equal(activity.activeSlice({ ...prev, was_active: false }, now, { idleSeconds: 0 }), null);
  assert.equal(activity.activeSlice(prev, '2026-11-14T13:00:00Z', { idleSeconds: 0 }), null);
  assert.equal(activity.activeSlice(prev, '2026-11-14T11:59:59Z', { idleSeconds: 0 }), null);
});
test('Посещение нельзя привязать к другому пользователю или сессии даже зная его UUID', async () => {
  visit = { ...prev, user_id: 7, login: 'other', session_hash: 'other-session' };
  const input = { visitId: '22222222-2222-4222-8222-222222222222', idleSeconds: 0, visible: true, page: 'sales', cabinet: 'defly' };
  await assert.rejects(activity.heartbeat({ id: 8, login: 'worker' }, 'session', input), e => e.status === 403);
  assert.ok(log.includes('ROLLBACK')); assert.equal(spans.length, 0);
  visit = { ...prev, user_id: 8, login: 'worker', session_hash: 'other-session' };
  await assert.rejects(activity.heartbeat({ id: 8, login: 'worker' }, 'session', input), e => e.status === 403);
});
test('Время после завершённого посещения не накапливается', async () => {
  visit = { ...prev, user_id: 8, login: 'worker', session_hash: 'session', ended_at: prev.last_seen_at };
  spans = []; log = [];
  await activity.heartbeat({ id: 8, login: 'worker' }, 'session', { visitId: '22222222-2222-4222-8222-222222222222', idleSeconds: 0, visible: true });
  assert.equal(spans.length, 0); assert.ok(!log.some(s => s.startsWith('UPDATE app_access_visits')));
});
test('Длительность не принимается от клиента; тело и границы периода проверяются', () => {
  assert.equal(activity.cleanInput({ visitId: 'bad', idleSeconds: 0 }), null);
  assert.equal(activity.cleanInput({ visitId: '22222222-2222-4222-8222-222222222222', idleSeconds: -1 }), null);
  const input = activity.cleanInput({ visitId: '22222222-2222-4222-8222-222222222222', idleSeconds: 1, seconds: 999999, visible: true });
  assert.equal('seconds' in input, false);
  assert.throws(() => activity.period({ from: 'bad' }), /период/);
  assert.throws(() => activity.period({ from: '2026-01-01', to: '2026-11-14' }), /период/);
});
