const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/lib/accessPolicy');
const owner = { id: 1, login: 'evgeniy', role: 'owner' };
const admin = { id: 2, login: 'manager', role: 'admin' };
const users = new Map([[1, owner], [2, admin], [3, { id: 3, login: 'worker', role: 'user' }]]);
const sqlLog = [];
const fakeQuery = async (sql, args = []) => {
  sqlLog.push(sql);
  if (sql.includes('WHERE id=$1 FOR UPDATE')) return [users.get(Number(args[0]))].filter(Boolean);
  if (sql.startsWith('DELETE FROM app_users')) { users.delete(Number(args[0])); return []; }
  return [];
};
const client = { query: async (sql, args) => ({ rows: await fakeQuery(sql, args) }), release() {} };
require.cache[require.resolve('../src/db')] = { exports: { query: fakeQuery, getPool: () => ({ connect: async () => client }) } };
process.env.AUTH_ENABLED = '1';
const A = require('../src/lib/auth'); A.ensure = async () => {};
const activity = require('../src/lib/accessActivity');
activity.report = async () => ({ summary: [], visits: [], logins: [] });
const router = require('../src/routes/auth');
async function call(method, path, user, body = {}, params = {}) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
  let status = 200, payload, headers = {};
  const res = { status(v) { status = v; return this; }, set(k,v) { headers[k] = v; return this; }, json(v) { payload = v; } };
  await route.route.stack[0].handle({ user, body, params, query: {}, headers: {} }, res);
  return { status, payload, headers };
}
test('Журнал доступен только evgeniy с ролью владельца; роль администратора и служебный ключ не дают доступа', async () => {
  for (const user of [admin, undefined, { id: 4, login: 'worker', role: 'user' }, { id: 1, login: 'evgeniy', role: 'admin' }, { id: 9, login: 'other', role: 'owner' }]) {
    assert.equal((await call('get', '/activity/report', user)).status, 403);
  }
  const r = await call('get', '/activity/report', owner);
  assert.equal(r.status, 200); assert.equal(r.headers['Cache-Control'], 'no-store');
});
test('Администратор не получает last_login и не видит главного администратора в списке управления', async () => {
  sqlLog.length = 0; await call('get', '/users', admin);
  const sql = sqlLog.at(-1); assert.ok(!sql.includes('last_login')); assert.match(sql, /WHERE role='user'/);
  sqlLog.length = 0; await call('get', '/users', owner); assert.match(sqlLog.at(-1), /last_login/);
});
test('Администратор не может назначить администратора, занять evgeniy или менять существующие роли', async () => {
  assert.equal((await call('post', '/users', admin, { login: 'newadmin', password: 'example-pass', role: 'admin' })).status, 403);
  assert.equal((await call('post', '/users', admin, { login: 'evgeniy', password: 'example-pass', role: 'user' })).status, 403);
  assert.equal((await call('post', '/users', admin, { id: 3, role: 'admin' })).status, 403);
  assert.equal((await call('post', '/users', admin, { login: 'newworker', password: 'example-pass', role: 'user' })).status, 200);
});
test('Нельзя удалить владельца и других администраторов; обычного пользователя удалить можно', async () => {
  assert.equal((await call('delete', '/users/:id', admin, {}, { id: '1' })).status, 403);
  assert.equal((await call('delete', '/users/:id', admin, {}, { id: '2' })).status, 403);
  assert.equal((await call('delete', '/users/:id', owner, {}, { id: '1' })).status, 403);
  assert.equal((await call('delete', '/users/:id', admin, {}, { id: '3' })).status, 200);
  assert.equal(users.has(3), false);
});
test('Главного администратора нельзя отключить или понизить, короткий пароль проверяется до записи', async () => {
  assert.equal((await call('post', '/users', owner, { id: 1, role: 'user' })).status, 400);
  assert.equal((await call('post', '/users', owner, { id: 1, disabled: true })).status, 400);
  sqlLog.length = 0;
  assert.equal((await call('post', '/users', owner, { id: 2, password: '123' })).status, 400);
  assert.ok(!sqlLog.some(sql => /UPDATE/.test(sql)));
});
test('Ключи программ и данные входов закрыты для второго администратора и сервера без авторизации', async () => {
  for (const method of ['get', 'post', 'delete']) {
    const path = method === 'delete' ? '/keys/:id' : '/keys';
    assert.equal((await call(method, path, admin, {}, { id: '1' })).status, 403);
  }
  process.env.AUTH_ENABLED = '0';
  assert.equal((await call('get', '/users', undefined)).status, 403);
  assert.equal((await call('get', '/activity/report', undefined)).status, 403);
  process.env.AUTH_ENABLED = '1';
});
test('Владелец определяется точным логином и ролью, обычная роль не повышает полномочия', () => {
  assert.equal(policy.isOwner({ user: owner }), true);
  assert.equal(policy.isOwner({ user: { ...owner, login: 'other' } }), false);
  assert.equal(policy.isAdmin({ user: admin }), true);
  assert.equal(policy.isAdmin({}), false);
});
